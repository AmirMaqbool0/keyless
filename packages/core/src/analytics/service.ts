import type { Types } from 'mongoose';
import {
  PLANS,
  computeOrderValue,
  ISSUE_LABELS,
  type AnalyticsSummaryDto,
  type CustomerVolumeStat,
  type DailyOrderStat,
  type ValueReportDto,
} from '@keyless/shared';
import { Order } from '../models/Order';
import { Organization } from '../models/Organization';

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? (sorted[mid] ?? null)
    : Number((((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2).toFixed(1));
}

export async function getAnalyticsSummary(
  orgId: Types.ObjectId,
  dateRange?: { from?: Date; to?: Date },
): Promise<AnalyticsSummaryDto> {
  const org = await Organization.findById(orgId);
  const currency = org?.currency || 'GBP';
  const minutesPerOrder = org?.settings.minutesSavedPerOrder ?? 10;
  const hourlyCost = org?.settings.hourlyStaffCost ?? 18;
  const greenThreshold = org?.settings.greenConfidenceThreshold ?? 0.9;

  const filter: Record<string, unknown> = { orgId };
  if (dateRange?.from || dateRange?.to) {
    const receivedAt: Record<string, Date> = {};
    if (dateRange.from) receivedAt.$gte = dateRange.from;
    if (dateRange.to) receivedAt.$lte = dateRange.to;
    filter.receivedAt = receivedAt;
  }

  const orders = await Order.find(filter).sort({ receivedAt: 1 }).lean();

  let totalValue = 0;
  let approvedCount = 0;
  let autoApprovedCount = 0;
  let rejectedCount = 0;
  let heldCount = 0;
  let totalLines = 0;
  let linesRequiringEdits = 0;
  let linesAutoMatched = 0;
  const approvalDurations: number[] = [];
  const pushDurations: number[] = [];

  const dayMap = new Map<string, DailyOrderStat>();
  const customerMap = new Map<string, CustomerVolumeStat>();
  const issueMap = new Map<string, { count: number; label: string; severity: 'info' | 'warning' | 'error' }>();

  for (const o of orders) {
    const val = o.value ?? computeOrderValue(o.lines).value ?? o.documentTotals?.total ?? 0;
    totalValue += val;

    const isApproved = ['approved', 'pushing', 'pushed'].includes(o.status);
    if (isApproved) approvedCount++;
    if (o.status === 'rejected') rejectedCount++;
    if (o.status === 'on_hold') heldCount++;

    for (const l of o.lines) {
      totalLines++;
      const isUnmatched = !l.sku && !l.productId;
      const isEdited = Boolean(l.edited);
      // Lines requiring edits = lines with edited = true or unmatched at extraction
      if (isEdited || isUnmatched) {
        linesRequiringEdits++;
      }
      // Match rate = lines auto-matched above threshold without manual edit
      if (!isEdited && !isUnmatched && (l.matchConfidence ?? 0) >= greenThreshold) {
        linesAutoMatched++;
      }
    }

    if (o.autoApproved) {
      autoApprovedCount++;
    }

    // Durations: email receipt -> approved
    if (o.approvedAt && o.receivedAt) {
      const minutes = Math.max(0, (new Date(o.approvedAt).getTime() - new Date(o.receivedAt).getTime()) / (60 * 1000));
      approvalDurations.push(Number(minutes.toFixed(1)));
    }

    // Durations: email receipt -> pushed to ERP
    if (o.pushedAt && o.receivedAt) {
      const minutes = Math.max(0, (new Date(o.pushedAt).getTime() - new Date(o.receivedAt).getTime()) / (60 * 1000));
      pushDurations.push(Number(minutes.toFixed(1)));
    }

    // Daily breakdown
    const dayKey = new Date(o.receivedAt).toISOString().split('T')[0] ?? 'unknown';
    const existingDay = dayMap.get(dayKey) || {
      date: dayKey,
      total: 0,
      autoApproved: 0,
      manualApproved: 0,
      heldOrRejected: 0,
      totalValue: 0,
    };
    existingDay.total += 1;
    existingDay.totalValue += val;
    if (o.autoApproved) {
      existingDay.autoApproved += 1;
    } else if (isApproved) {
      existingDay.manualApproved += 1;
    } else if (['on_hold', 'rejected'].includes(o.status)) {
      existingDay.heldOrRejected += 1;
    }
    dayMap.set(dayKey, existingDay);

    // Customer breakdown
    const custKey = o.customerId ? o.customerId.toString() : (o.customerMatch?.name || 'Unidentified');
    const custName = o.customerMatch?.name || 'Unidentified customer';
    const custCode = o.customerMatch?.accountCode || '-';
    const existingCust = customerMap.get(custKey) || {
      customerId: o.customerId ? o.customerId.toString() : null,
      name: custName,
      accountCode: custCode,
      orderCount: 0,
      totalValue: 0,
    };
    existingCust.orderCount += 1;
    existingCust.totalValue += val;
    customerMap.set(custKey, existingCust);

    // Issue reasons grouped by issue code with a short human label, never the raw message.
    for (const issue of o.issues) {
      const existingIssue = issueMap.get(issue.code) || {
        count: 0,
        label: ISSUE_LABELS[issue.code] || issue.code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        severity: issue.severity || 'warning',
      };
      existingIssue.count += 1;
      issueMap.set(issue.code, existingIssue);
    }
  }

  const totalOrders = orders.length;

  // Touch-free rate = orders pushed with zero edits and no manual approval (auto-approved) / orders processed
  const touchFreeCount = orders.filter(
    (o) => o.autoApproved && o.status === 'pushed' && !o.lines.some((l) => l.edited),
  ).length;
  const touchFreeRate = totalOrders > 0 ? Number(((touchFreeCount / totalOrders) * 100).toFixed(1)) : 0;

  // Lines requiring edits = lines with edited = true or unmatched at extraction / total lines
  const linesCorrectedPct = totalLines > 0 ? Number(((linesRequiringEdits / totalLines) * 100).toFixed(1)) : 0;

  // Match rate = lines auto-matched above threshold / total lines
  const matchRate = totalLines > 0 ? Number(((linesAutoMatched / totalLines) * 100).toFixed(1)) : 0;

  // Median email->approved and email->pushed as two separate metrics; null when no data
  const medianMinutesToApprove = median(approvalDurations);
  const medianMinutesToPush = median(pushDurations);

  const estimatedHoursSaved = Number(((touchFreeCount * minutesPerOrder) / 60).toFixed(1));
  const estimatedCostSaved = Number((estimatedHoursSaved * hourlyCost).toFixed(2));

  const ordersByDay = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const topCustomers = [...customerMap.values()]
    .sort((a, b) => b.orderCount - a.orderCount)
    .slice(0, 10);
  const topIssues = [...issueMap.entries()]
    .map(([code, data]) => ({
      code,
      count: data.count,
      label: data.label,
      severity: data.severity,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalOrders,
    approvedOrders: approvedCount,
    autoApprovedOrders: autoApprovedCount,
    rejectedOrders: rejectedCount,
    heldOrders: heldCount,
    totalValue: Number(totalValue.toFixed(2)),
    touchFreeRate,
    medianMinutesToApprove,
    medianMinutesToPush,
    matchRate,
    linesCorrectedPct,
    estimatedHoursSaved,
    estimatedCostSaved,
    currency,
    ordersByDay,
    topCustomers,
    topIssues,
    settings: {
      minutesSavedPerOrder: minutesPerOrder,
      hourlyStaffCost: hourlyCost,
    },
  };
}

export async function getValueReport(
  orgId: Types.ObjectId,
  periodDays: number = 30,
): Promise<ValueReportDto> {
  const from = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const summary = await getAnalyticsSummary(orgId, { from });
  const org = await Organization.findById(orgId);

  const planId = org?.plan || 'starter';
  const monthlyCost = PLANS[planId]?.priceMonthly || 295;
  const normalizedPlanCost = Math.max(1, (monthlyCost / 30) * periodDays);

  const roiMultiple = Number((summary.estimatedCostSaved / normalizedPlanCost).toFixed(1));
  const accuracyRate = Number(Math.max(0, 100 - summary.linesCorrectedPct).toFixed(1));

  const keyInsights: string[] = [
    `Processed ${summary.totalOrders} purchase orders with a ${summary.touchFreeRate}% touch-free straight-through processing rate.`,
    `Saved an estimated ${summary.estimatedHoursSaved} hours of manual order entry (£${summary.estimatedCostSaved.toLocaleString()} in operational labour).`,
    `Catalogue matching achieved a ${accuracyRate}% line accuracy rate with minimal corrections.`,
  ];

  if (summary.topCustomers.length > 0 && summary.topCustomers[0]) {
    const top = summary.topCustomers[0];
    keyInsights.push(
      `Top customer "${top.name}" generated ${top.orderCount} orders totaling ${summary.currency} ${top.totalValue.toFixed(2)}.`,
    );
  }

  return {
    periodLabel: `Last ${periodDays} Days`,
    totalOrders: summary.totalOrders,
    touchFreeOrders: summary.autoApprovedOrders,
    touchFreeRate: summary.touchFreeRate,
    hoursSaved: summary.estimatedHoursSaved,
    costSaved: summary.estimatedCostSaved,
    accuracyRate,
    roiMultiple,
    topCustomers: summary.topCustomers.slice(0, 5),
    keyInsights,
  };
}
