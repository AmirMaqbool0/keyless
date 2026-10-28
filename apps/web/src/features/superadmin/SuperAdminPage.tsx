import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FailedJobDto, PlatformMetricsDto, TenantOverviewDto, UserDto } from '@keyless/shared';
import { Badge, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { api } from '../../lib/api';

export function SuperAdminPage() {
  const queryClient = useQueryClient();
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [impersonatingUser, setImpersonatingUser] = useState<string | null>(null);

  // Platform Metrics
  const { data: metricsData, isLoading: loadingMetrics } = useQuery<{ metrics: PlatformMetricsDto }>({
    queryKey: ['superadmin', 'metrics'],
    queryFn: () => api.get('/api/superadmin/metrics'),
  });

  // Tenants Overview
  const { data: tenantsData, isLoading: loadingTenants } = useQuery<{ tenants: TenantOverviewDto[] }>({
    queryKey: ['superadmin', 'tenants'],
    queryFn: () => api.get('/api/superadmin/tenants'),
  });

  // Failed Jobs
  const { data: jobsData, isLoading: loadingJobs } = useQuery<{ jobs: FailedJobDto[] }>({
    queryKey: ['superadmin', 'failed-jobs'],
    queryFn: () => api.get('/api/superadmin/failed-jobs'),
  });

  // Selected Tenant Details (for user impersonation picker)
  const { data: tenantDetail, isLoading: loadingDetail } = useQuery<{
    users: UserDto[];
    organization: { name: string; slug: string };
  }>({
    queryKey: ['superadmin', 'tenants', selectedTenantId],
    queryFn: () => api.get(`/api/superadmin/tenants/${selectedTenantId}`),
    enabled: Boolean(selectedTenantId),
  });

  // Retry Job Mutation
  const retryMutation = useMutation({
    mutationFn: (jobId: string) => api.post(`/api/superadmin/failed-jobs/${jobId}/retry`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['superadmin', 'failed-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['superadmin', 'metrics'] });
    },
  });

  // Dismiss Job Mutation
  const dismissMutation = useMutation({
    mutationFn: (jobId: string) => api.post(`/api/superadmin/failed-jobs/${jobId}/dismiss`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['superadmin', 'failed-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['superadmin', 'metrics'] });
    },
  });

  // Impersonate Mutation
  const impersonateMutation = useMutation({
    mutationFn: (userId: string) => {
      setImpersonatingUser(userId);
      return api.post(`/api/superadmin/impersonate/${userId}`);
    },
    onSuccess: () => {
      // Reload page to re-authenticate as the impersonated user
      window.location.href = '/';
    },
    onError: () => {
      setImpersonatingUser(null);
    },
  });

  const metrics = metricsData?.metrics;
  const tenants = tenantsData?.tenants ?? [];
  const jobs = jobsData?.jobs ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Super-admin Platform Console"
        description="Monitor system-wide metrics, oversee active tenants, retry failed queue tasks, and provide authorized customer support."
      />

      {/* High-level KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Total Tenants</div>
          <div className="mt-2 text-2xl font-bold text-slate-900">
            {loadingMetrics ? <Spinner className="size-5" /> : (metrics?.totalTenants ?? 0)}
          </div>
        </Card>

        <Card>
          <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Active Subscriptions</div>
          <div className="mt-2 text-2xl font-bold text-emerald-600">
            {loadingMetrics ? <Spinner className="size-5" /> : (metrics?.activeSubscriptions ?? 0)}
          </div>
        </Card>

        <Card>
          <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Total Orders Processed</div>
          <div className="mt-2 text-2xl font-bold text-brand-700">
            {loadingMetrics ? <Spinner className="size-5" /> : (metrics?.totalOrdersProcessed ?? 0)}
          </div>
        </Card>

        <Card>
          <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Est. Total LLM Cost</div>
          <div className="mt-2 text-2xl font-bold text-slate-900">
            {loadingMetrics ? (
              <Spinner className="size-5" />
            ) : (
              `$${(metrics?.totalLlmCost ?? 0).toFixed(2)}`
            )}
          </div>
        </Card>

        <Card>
          <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Failed Queue Jobs</div>
          <div className="mt-2 text-2xl font-bold text-red-600">
            {loadingMetrics ? <Spinner className="size-5" /> : (metrics?.totalFailedJobs ?? 0)}
          </div>
        </Card>
      </div>

      {/* Impersonation Selection Modal / Drawer */}
      {selectedTenantId && (
        <Card
          title="Tenant Support Impersonation"
          description="Select a user from this organization to open a support session. All actions will be logged in the audit trail under your operator identity."
          actions={
            <Button variant="secondary" onClick={() => setSelectedTenantId(null)}>
              Close
            </Button>
          }
          className="border-brand-200 bg-brand-50/20"
        >
          {loadingDetail ? (
            <div className="py-6 text-center">
              <Spinner className="mx-auto size-6 text-brand-600" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-semibold text-slate-500">
                    <th className="pb-2">Name</th>
                    <th className="pb-2">Email</th>
                    <th className="pb-2">Role</th>
                    <th className="pb-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {tenantDetail?.users.map((u) => (
                    <tr key={u.id} className="hover:bg-white">
                      <td className="py-2.5 font-medium text-slate-900">{u.name}</td>
                      <td className="py-2.5 text-slate-600">{u.email}</td>
                      <td className="py-2.5">
                        <Badge tone="slate">{u.role}</Badge>
                      </td>
                      <td className="py-2.5 text-right">
                        <Button
                          variant="secondary"
                          loading={impersonatingUser === u.id}
                          onClick={() => impersonateMutation.mutate(u.id)}
                        >
                          Impersonate User
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Tenants Table */}
      <Card
        title="Tenant Directory & Resource Usage"
        description="Comprehensive list of all registered tenant organizations, their order volumes, error rates, and estimated LLM costs."
      >
        {loadingTenants ? (
          <div className="py-8 text-center">
            <Spinner className="mx-auto size-6 text-brand-600" />
          </div>
        ) : tenants.length === 0 ? (
          <EmptyState title="No active tenants found" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-semibold text-slate-500">
                  <th className="pb-3">Organization</th>
                  <th className="pb-3">Plan</th>
                  <th className="pb-3">Status</th>
                  <th className="pb-3 text-right">Users</th>
                  <th className="pb-3 text-right">This Month</th>
                  <th className="pb-3 text-right">Total Orders</th>
                  <th className="pb-3 text-right">Error Rate</th>
                  <th className="pb-3 text-right">Est. LLM Cost</th>
                  <th className="pb-3 text-right">Support Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tenants.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50/70">
                    <td className="py-3">
                      <div className="font-medium text-slate-900">{t.name}</div>
                      <div className="text-xs text-slate-400">{t.slug}</div>
                    </td>
                    <td className="py-3 capitalize">
                      <Badge tone={t.plan === 'pro' ? 'brand' : 'slate'}>{t.plan}</Badge>
                    </td>
                    <td className="py-3">
                      <Badge
                        tone={
                          t.subscriptionStatus === 'active'
                            ? 'green'
                            : t.subscriptionStatus === 'past_due'
                              ? 'red'
                              : 'amber'
                        }
                      >
                        {t.subscriptionStatus}
                      </Badge>
                    </td>
                    <td className="py-3 text-right text-slate-700">{t.userCount}</td>
                    <td className="py-3 text-right font-medium text-slate-900">
                      {t.orderCountThisMonth}
                    </td>
                    <td className="py-3 text-right text-slate-700">{t.totalOrders}</td>
                    <td className="py-3 text-right">
                      <span
                        className={
                          t.errorRatePct > 15
                            ? 'font-semibold text-red-600'
                            : t.errorRatePct > 5
                              ? 'text-amber-600'
                              : 'text-slate-600'
                        }
                      >
                        {t.errorRatePct}%
                      </span>
                    </td>
                    <td className="py-3 text-right text-slate-700">
                      ${t.estimatedLlmCost.toFixed(2)}
                    </td>
                    <td className="py-3 text-right">
                      <Button
                        variant="secondary"
                        onClick={() => setSelectedTenantId(t.id)}
                      >
                        Support
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Failed Queue Jobs Table */}
      <Card
        title="Failed Queue Jobs"
        description="Review background worker tasks that exhausted maximum retries. Inspect stack traces, retry failed tasks, or dismiss stale failures."
      >
        {loadingJobs ? (
          <div className="py-8 text-center">
            <Spinner className="mx-auto size-6 text-brand-600" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 py-8 text-center text-sm text-slate-500">
            All background queue jobs are operating normally. Zero failed jobs.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-semibold text-slate-500">
                  <th className="pb-3">Task Name</th>
                  <th className="pb-3">Org ID</th>
                  <th className="pb-3">Attempts</th>
                  <th className="pb-3">Last Error</th>
                  <th className="pb-3">Failed At</th>
                  <th className="pb-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-slate-50/70">
                    <td className="py-3 font-mono text-xs font-semibold text-slate-900">
                      {job.type}
                    </td>
                    <td className="py-3 font-mono text-xs text-slate-500">
                      {job.orgId || 'Platform'}
                    </td>
                    <td className="py-3 text-slate-700">
                      {job.attempts} / {job.maxAttempts}
                    </td>
                    <td className="max-w-xs truncate py-3 text-xs text-red-600" title={job.lastError}>
                      {job.lastError}
                    </td>
                    <td className="py-3 text-xs text-slate-500">
                      {new Date(job.failedAt).toLocaleString()}
                    </td>
                    <td className="space-x-2 py-3 text-right">
                      <Button
                        variant="secondary"
                        loading={retryMutation.isPending}
                        onClick={() => retryMutation.mutate(job.id)}
                      >
                        Retry
                      </Button>
                      <Button
                        variant="ghost"
                        loading={dismissMutation.isPending}
                        onClick={() => dismissMutation.mutate(job.id)}
                      >
                        Dismiss
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
