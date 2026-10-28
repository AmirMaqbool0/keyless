import { z } from 'zod';

export type DailyOrderStat = {
  date: string;
  total: number;
  autoApproved: number;
  manualApproved: number;
  heldOrRejected: number;
  totalValue: number;
};

export type CustomerVolumeStat = {
  customerId: string | null;
  name: string;
  accountCode: string;
  orderCount: number;
  totalValue: number;
};

export type IssueBreakdownStat = {
  code: string;
  count: number;
  label: string;
  severity: 'info' | 'warning' | 'error';
};

export const ISSUE_LABELS: Record<string, string> = {
  customer_unknown: 'Unknown customer',
  unknown_customer: 'Unknown customer',
  price_mismatch: 'Price mismatch',
  code_description_mismatch: 'Code / description mismatch',
  uom_conversion: 'Pack size / unit conversion',
  pack_multiple: 'Non-integer pack quantity',
  unknown_items: 'Unmatched items',
  low_confidence_read: 'Low OCR/read confidence',
  unreadable: 'Unreadable document',
  empty_document: 'No order lines found',
  credit_hold: 'Credit hold',
  duplicate_po: 'Duplicate PO',
  insufficient_stock: 'Insufficient inventory',
  high_value: 'High order value',
  new_delivery_address: 'New delivery address',
  partial_extraction: 'Partial document read',
  sku_inactive: 'Inactive catalogue SKU',
  zero_quantity: 'Zero quantity',
  below_minimum_order: 'Below minimum order',
  po_already_used: 'PO number reused',
};

export type AnalyticsSummaryDto = {
  totalOrders: number;
  approvedOrders: number;
  autoApprovedOrders: number;
  rejectedOrders: number;
  heldOrders: number;
  totalValue: number;
  touchFreeRate: number; // percentage (0 - 100)
  medianMinutesToApprove: number | null; // minutes from received to approved (null if no data)
  medianMinutesToPush: number | null; // minutes from received to pushed (null if no data)
  matchRate: number; // percentage of lines auto-matched above threshold (0 - 100)
  linesCorrectedPct: number; // percentage of lines requiring edits or unmatched
  estimatedHoursSaved: number;
  estimatedCostSaved: number;
  currency: string;
  ordersByDay: DailyOrderStat[];
  topCustomers: CustomerVolumeStat[];
  topIssues: IssueBreakdownStat[];
  settings: {
    minutesSavedPerOrder: number;
    hourlyStaffCost: number;
  };
};

export type ValueReportDto = {
  periodLabel: string;
  totalOrders: number;
  touchFreeOrders: number;
  touchFreeRate: number;
  hoursSaved: number;
  costSaved: number;
  accuracyRate: number;
  roiMultiple: number; // e.g. savings / plan cost
  topCustomers: CustomerVolumeStat[];
  keyInsights: string[];
};

export const updateAnalyticsSettingsSchema = z.object({
  minutesSavedPerOrder: z.number().min(1).max(60).optional(),
  hourlyStaffCost: z.number().min(1).max(500).optional(),
});

export type UpdateAnalyticsSettingsInput = z.infer<typeof updateAnalyticsSettingsSchema>;
