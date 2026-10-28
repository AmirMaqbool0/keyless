import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { toast } from 'sonner';
import type {
  AnalyticsSummaryDto,
  UpdateAnalyticsSettingsInput,
  ValueReportDto,
} from '@keyless/shared';
import { Badge, Button, Card, Modal, PageHeader, Spinner, TextField } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useHasRole } from '../../lib/session';

export function AnalyticsPage() {
  const canAdmin = useHasRole('admin');
  const qc = useQueryClient();

  const [days, setDays] = useState<number>(30);
  const [valueReportOpen, setValueReportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Calculate dates
  const toDate = new Date();
  const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fromParam = fromDate.toISOString().split('T')[0];
  const toParam = toDate.toISOString().split('T')[0];

  const summary = useQuery({
    queryKey: ['analytics-summary', fromParam, toParam],
    queryFn: () =>
      api.get<AnalyticsSummaryDto>(`/api/analytics/summary?from=${fromParam}&to=${toParam}`),
  });

  const valueReport = useQuery({
    queryKey: ['value-report', days],
    queryFn: () => api.get<ValueReportDto>(`/api/analytics/value-report?days=${days}`),
    enabled: valueReportOpen,
  });

  // Settings state
  const [minutesPerOrder, setMinutesPerOrder] = useState<number>(10);
  const [hourlyStaffCost, setHourlyStaffCost] = useState<number>(18);

  const updateSettingsMutation = useMutation({
    mutationFn: (data: UpdateAnalyticsSettingsInput) =>
      api.patch('/api/analytics/settings', data),
    onSuccess: () => {
      toast.success('Analytics calculation settings updated');
      setSettingsOpen(false);
      void qc.invalidateQueries({ queryKey: ['analytics-summary'] });
      void qc.invalidateQueries({ queryKey: ['value-report'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const d = summary.data;

  return (
    <>
      <PageHeader
        title="Analytics &amp; Value Dashboard"
        description="Track straight-through processing rates, operational time saved, catalogue matching accuracy, and error causes."
        actions={
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-xs font-medium">
              {[
                { label: '7 Days', val: 7 },
                { label: '30 Days', val: 30 },
                { label: '90 Days', val: 90 },
              ].map((opt) => (
                <button
                  key={opt.val}
                  type="button"
                  onClick={() => setDays(opt.val)}
                  className={clsx(
                    'rounded px-2.5 py-1 transition-colors',
                    days === opt.val
                      ? 'bg-brand-50 text-brand-700 font-semibold shadow-xs'
                      : 'text-slate-600 hover:text-slate-900',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <Button variant="secondary" onClick={() => setValueReportOpen(true)}>
              Value Report (ROI)
            </Button>

            {canAdmin && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (d) {
                    setMinutesPerOrder(d.settings.minutesSavedPerOrder);
                    setHourlyStaffCost(d.settings.hourlyStaffCost);
                  }
                  setSettingsOpen(true);
                }}
                title="Configure hourly labour cost and baseline time per order"
              >
                ⚙ Settings
              </Button>
            )}
          </div>
        }
      />

      {summary.isPending ? (
        <div className="py-12 flex justify-center">
          <Spinner className="size-8 text-brand-600" />
        </div>
      ) : !d ? (
        <Card>
          <div className="py-12 text-center text-slate-500">Failed to load analytics summary.</div>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Top KPI Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs transition hover:shadow-md">
              <div className="flex items-center justify-between text-slate-500 text-xs font-semibold uppercase tracking-wider">
                <span>Orders Processed</span>
                <span className="rounded-full bg-blue-50 p-1.5 text-blue-600">📦</span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold text-slate-900">{d.totalOrders}</span>
                <span className="text-xs text-slate-500">orders</span>
              </div>
              <div className="mt-2 text-xs text-slate-500 flex items-center gap-1.5">
                <span className="text-emerald-700 font-medium">{d.approvedOrders} approved</span>
                <span>•</span>
                <span>{d.heldOrders} held</span>
                <span>•</span>
                <span>{d.rejectedOrders} rejected</span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs transition hover:shadow-md">
              <div className="flex items-center justify-between text-slate-500 text-xs font-semibold uppercase tracking-wider">
                <span>Touch-Free Rate</span>
                <span className="rounded-full bg-emerald-50 p-1.5 text-emerald-600">⚡</span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold text-emerald-600">{d.touchFreeRate}%</span>
                <span className="text-xs text-slate-500">auto / zero touch</span>
              </div>
              <div className="mt-2">
                <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-emerald-500 h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, d.touchFreeRate)}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500">
                  {d.autoApprovedOrders} orders auto-approved without touch
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs transition hover:shadow-md">
              <div className="flex items-center justify-between text-slate-500 text-xs font-semibold uppercase tracking-wider">
                <span>Labour Time Saved</span>
                <span className="rounded-full bg-indigo-50 p-1.5 text-indigo-600">⏱</span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold text-indigo-600">{d.estimatedHoursSaved}</span>
                <span className="text-xs text-slate-500">hours</span>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                At {d.settings.minutesSavedPerOrder} mins saved per automated PO
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs transition hover:shadow-md">
              <div className="flex items-center justify-between text-slate-500 text-xs font-semibold uppercase tracking-wider">
                <span>Estimated Value Saved</span>
                <span className="rounded-full bg-purple-50 p-1.5 text-purple-600">💰</span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold text-purple-700">
                  £{d.estimatedCostSaved.toLocaleString()}
                </span>
                <span className="text-xs text-slate-500">GBP</span>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Based on £{d.settings.hourlyStaffCost}/hr internal staff labour cost
              </p>
            </div>
          </div>

          {/* Secondary Stats Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4">
              <span className="text-xs font-medium text-slate-500">Median Time to Approve</span>
              <p className="mt-1 text-xl font-bold text-slate-800">
                {d.medianMinutesToApprove !== null ? `${d.medianMinutesToApprove} mins` : '—'}
              </p>
              <span className="text-[11px] text-slate-400">From email receipt to approval</span>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4">
              <span className="text-xs font-medium text-slate-500">Median Time to Push</span>
              <p className="mt-1 text-xl font-bold text-slate-800">
                {d.medianMinutesToPush !== null ? `${d.medianMinutesToPush} mins` : '—'}
              </p>
              <span className="text-[11px] text-slate-400">From email receipt to ERP push</span>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4">
              <span className="text-xs font-medium text-slate-500">Line Items Requiring Edits</span>
              <p className="mt-1 text-xl font-bold text-slate-800">{d.linesCorrectedPct}%</p>
              <span className="text-[11px] text-slate-400">
                {d.matchRate !== undefined
                  ? `${d.matchRate}% auto-matched cleanly`
                  : `${(100 - d.linesCorrectedPct).toFixed(1)}% matched automatically`}
              </span>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4">
              <span className="text-xs font-medium text-slate-500">Total Order Value Processed</span>
              <p className="mt-1 text-xl font-bold text-slate-800">
                £{d.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </p>
              <span className="text-[11px] text-slate-400">Across {d.totalOrders} total purchase orders</span>
            </div>
          </div>

          {/* Charts & Breakdown Rows */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Daily Trend Chart (Left 2 cols) */}
            <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
              <h2 className="text-sm font-bold text-slate-900 mb-4">Daily Volume &amp; Automation Trend</h2>
              {d.ordersByDay.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-sm text-slate-400 italic">
                  No orders processed in this date range.
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-end gap-4 text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="size-2.5 rounded-xs bg-emerald-500" /> Auto-Approved
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="size-2.5 rounded-xs bg-blue-500" /> Manual Approved
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="size-2.5 rounded-xs bg-amber-400" /> Held / Rejected
                    </span>
                  </div>

                  {/* HTML5 / SVG Bars */}
                  <div className="space-y-2 pt-2">
                    {d.ordersByDay.map((day) => {
                      const maxDay = Math.max(...d.ordersByDay.map((x) => x.total), 1);
                      const autoW = (day.autoApproved / maxDay) * 100;
                      const manualW = (day.manualApproved / maxDay) * 100;
                      const heldW = (day.heldOrRejected / maxDay) * 100;

                      return (
                        <div key={day.date} className="flex items-center gap-3 text-xs">
                          <span className="w-20 shrink-0 font-mono text-slate-500">
                            {day.date.slice(5)}
                          </span>
                          <div className="flex-1 bg-slate-100 rounded-sm h-5 overflow-hidden flex">
                            {day.autoApproved > 0 && (
                              <div
                                style={{ width: `${autoW}%` }}
                                className="bg-emerald-500 h-full flex items-center justify-center text-[10px] text-white font-medium px-1"
                                title={`Auto: ${day.autoApproved}`}
                              >
                                {day.autoApproved}
                              </div>
                            )}
                            {day.manualApproved > 0 && (
                              <div
                                style={{ width: `${manualW}%` }}
                                className="bg-blue-500 h-full flex items-center justify-center text-[10px] text-white font-medium px-1"
                                title={`Manual: ${day.manualApproved}`}
                              >
                                {day.manualApproved}
                              </div>
                            )}
                            {day.heldOrRejected > 0 && (
                              <div
                                style={{ width: `${heldW}%` }}
                                className="bg-amber-400 h-full flex items-center justify-center text-[10px] text-white font-medium px-1"
                                title={`Held/Rejected: ${day.heldOrRejected}`}
                              >
                                {day.heldOrRejected}
                              </div>
                            )}
                          </div>
                          <span className="w-12 text-right font-medium text-slate-700">
                            {day.total}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Top Issue Causes (Right 1 col) */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
              <h2 className="text-sm font-bold text-slate-900 mb-4">Top Review Reasons &amp; Issues</h2>
              {d.topIssues.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-sm text-emerald-600 font-medium">
                  ✓ Zero flagged issues in this period!
                </div>
              ) : (
                <div className="space-y-3">
                  {d.topIssues.map((issue) => (
                    <div
                      key={issue.code}
                      className="flex items-center justify-between p-2.5 rounded-lg border border-slate-100 hover:bg-slate-50 transition"
                    >
                      <div className="pr-2 truncate">
                        <p className="text-xs font-semibold text-slate-800 truncate">{issue.label}</p>
                        <span className="font-mono text-[10px] text-slate-400">{issue.code}</span>
                      </div>
                      <Badge tone={issue.severity === 'error' ? 'red' : 'amber'}>
                        {issue.count} {issue.count === 1 ? 'order' : 'orders'}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Top Customers Table */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
            <h2 className="text-sm font-bold text-slate-900 mb-4">Top Customers by Order Volume</h2>
            {d.topCustomers.length === 0 ? (
              <p className="text-sm text-slate-400 italic py-6 text-center">No customer data yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 text-slate-500 font-medium">
                    <tr>
                      <th className="pb-2.5 font-semibold">Customer</th>
                      <th className="pb-2.5 font-semibold">Account Code</th>
                      <th className="pb-2.5 font-semibold text-right">Orders Processed</th>
                      <th className="pb-2.5 font-semibold text-right">Total Spend (£)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {d.topCustomers.map((cust) => (
                      <tr key={cust.customerId ?? cust.name} className="hover:bg-slate-50">
                        <td className="py-2.5 font-medium text-slate-900">{cust.name}</td>
                        <td className="py-2.5 font-mono text-slate-500">{cust.accountCode}</td>
                        <td className="py-2.5 text-right font-semibold text-slate-800">
                          {cust.orderCount}
                        </td>
                        <td className="py-2.5 text-right font-mono font-medium text-slate-900">
                          £{cust.totalValue.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Value Report (ROI) Modal */}
      <Modal
        open={valueReportOpen}
        onClose={() => setValueReportOpen(false)}
        title="Executive Value &amp; ROI Report"
        maxWidth="max-w-2xl"
      >
        {valueReport.isPending ? (
          <div className="py-12 flex justify-center">
            <Spinner className="size-8 text-brand-600" />
          </div>
        ) : !valueReport.data ? (
          <p className="text-sm text-slate-500 py-6 text-center">Failed to load value report.</p>
        ) : (
          <div className="space-y-6">
            <div className="rounded-xl bg-gradient-to-br from-brand-600 to-indigo-700 p-6 text-white shadow-md">
              <span className="text-xs font-semibold uppercase tracking-wider text-brand-200">
                Keyless ROI Multiplier
              </span>
              <div className="mt-2 flex items-baseline gap-3">
                <span className="text-5xl font-black">{valueReport.data.roiMultiple}x</span>
                <span className="text-sm text-brand-100 font-medium">
                  Return on software investment ({valueReport.data.periodLabel})
                </span>
              </div>
              <p className="mt-3 text-xs text-brand-100 leading-relaxed">
                Calculated by comparing total labour cost saved (£{valueReport.data.costSaved.toLocaleString()})
                against your normalized Keyless subscription plan cost.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                <span className="text-xs text-slate-500">Orders Processed</span>
                <p className="text-xl font-bold text-slate-900 mt-1">{valueReport.data.totalOrders}</p>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                <span className="text-xs text-slate-500">Touchless Rate</span>
                <p className="text-xl font-bold text-emerald-600 mt-1">{valueReport.data.touchFreeRate}%</p>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                <span className="text-xs text-slate-500">Hours Saved</span>
                <p className="text-xl font-bold text-indigo-600 mt-1">{valueReport.data.hoursSaved} hrs</p>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                Automated Management Insights
              </h3>
              <ul className="space-y-2 text-xs text-slate-700 bg-slate-50 p-4 rounded-lg border border-slate-200">
                {valueReport.data.keyInsights.map((insight, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="text-emerald-500 font-bold shrink-0">✓</span>
                    <span>{insight}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Button variant="secondary" onClick={() => setValueReportOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Analytics Calculation Settings Modal */}
      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Analytics ROI Assumptions"
        maxWidth="max-w-md"
      >
        <p className="text-xs text-slate-500 mb-4">
          Adjust the baseline assumptions used to calculate estimated time and financial savings across your organisation.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            updateSettingsMutation.mutate({
              minutesSavedPerOrder: minutesPerOrder,
              hourlyStaffCost: hourlyStaffCost,
            });
          }}
          className="space-y-4"
        >
          <TextField
            label="Minutes Saved per Order (manual entry baseline)"
            type="number"
            min={1}
            max={60}
            value={minutesPerOrder}
            onChange={(e) => setMinutesPerOrder(Number(e.target.value))}
            hint="Average minutes an order processor takes to manually read & re-enter a PO"
          />
          <TextField
            label="Internal Staff Hourly Cost (£ / hour)"
            type="number"
            min={1}
            max={500}
            value={hourlyStaffCost}
            onChange={(e) => setHourlyStaffCost(Number(e.target.value))}
            hint="Average fully loaded hourly labour cost of sales order processing staff"
          />
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <Button variant="secondary" type="button" onClick={() => setSettingsOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={updateSettingsMutation.isPending}>
              Save Settings
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
