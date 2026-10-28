import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CustomerDto, Paginated, RuleAction, RuleDto } from '@keyless/shared';
import { Badge, Button, Card, Modal, PageHeader, SelectField, Spinner, TextField } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';

const ACTION_TONES: Record<RuleAction, 'green' | 'amber' | 'red'> = {
  auto_approve: 'green',
  require_review: 'amber',
  block: 'red',
};

const ACTION_LABELS: Record<RuleAction, string> = {
  auto_approve: 'Auto-Approve',
  require_review: 'Require Review',
  block: 'Block Order',
};

export function RulesPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<RuleDto | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [action, setAction] = useState<RuleAction>('auto_approve');
  const [priority, setPriority] = useState(10);
  const [customerId, setCustomerId] = useState('');
  const [maxValue, setMaxValue] = useState<string>('');
  const [minConfidence, setMinConfidence] = useState<string>('0.90');
  const [trustedOnly, setTrustedOnly] = useState(false);
  const [allLearnedOnly, setAllLearnedOnly] = useState(false);
  const [noIssuesOnly, setNoIssuesOnly] = useState(false);
  const [reason, setReason] = useState('');

  const list = useQuery({
    queryKey: ['rules'],
    queryFn: () => api.get<{ items: RuleDto[] }>('/api/rules'),
  });

  const customers = useQuery({
    queryKey: ['customers-list-simple'],
    queryFn: () => api.get<Paginated<CustomerDto>>('/api/customers?pageSize=100'),
    enabled: modalOpen,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['rules'] });
  };

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      editingRule
        ? api.patch(`/api/rules/${editingRule.id}`, payload)
        : api.post('/api/rules', payload),
    onSuccess: () => {
      toast.success(editingRule ? 'Rule updated' : 'Rule created');
      setModalOpen(false);
      resetForm();
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.patch(`/api/rules/${id}`, { active }),
    onSuccess: () => {
      toast.success('Rule status updated');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/rules/${id}`),
    onSuccess: () => {
      toast.success('Rule deleted');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function resetForm() {
    setEditingRule(null);
    setName('');
    setAction('auto_approve');
    setPriority(10);
    setCustomerId('');
    setMaxValue('');
    setMinConfidence('0.90');
    setTrustedOnly(false);
    setAllLearnedOnly(false);
    setNoIssuesOnly(false);
    setReason('');
  }

  function handleOpenCreate() {
    resetForm();
    setModalOpen(true);
  }

  function handleOpenEdit(r: RuleDto) {
    setEditingRule(r);
    setName(r.name);
    setAction(r.actions.action);
    setPriority(r.priority);
    setCustomerId(r.conditions.customerId ?? '');
    setMaxValue(r.conditions.maxOrderValue != null ? String(r.conditions.maxOrderValue) : '');
    setMinConfidence(r.conditions.minConfidence != null ? String(r.conditions.minConfidence) : '0.90');
    setTrustedOnly(Boolean(r.conditions.requireTrustedCustomer));
    setAllLearnedOnly(Boolean(r.conditions.requireAllLinesLearned));
    setNoIssuesOnly(Boolean(r.conditions.requireNoIssues));
    setReason(r.actions.reason ?? '');
    setModalOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      name,
      type: action,
      priority: Number(priority),
      active: editingRule ? editingRule.active : true,
      conditions: {
        customerId: customerId || undefined,
        maxOrderValue: maxValue ? Number(maxValue) : undefined,
        minConfidence: minConfidence ? Number(minConfidence) : undefined,
        requireTrustedCustomer: trustedOnly,
        requireAllLinesLearned: allLearnedOnly,
        requireNoIssues: noIssuesOnly,
      },
      actions: {
        action,
        reason: reason || undefined,
      },
    };
    saveMutation.mutate(payload);
  }

  return (
    <>
      <PageHeader
        title="Rules &amp; Routing Engine"
        description="Configure rules to automatically approve green orders, require reviews, or block high-risk purchase orders."
        actions={
          <Button onClick={handleOpenCreate}>
            + Create Rule
          </Button>
        }
      />

      {list.isPending ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          {list.data?.items.length === 0 ? (
            <Card>
              <div className="py-8 text-center text-slate-500">
                <p className="font-semibold text-slate-700">No routing rules configured</p>
                <p className="mt-1 text-sm">
                  By default, all orders require manual human approval before pushing to ERP. Create an auto-approve rule to automate routine POs!
                </p>
                <Button className="mt-4" onClick={handleOpenCreate}>
                  Create your first rule
                </Button>
              </div>
            </Card>
          ) : (
            list.data?.items.map((rule) => (
              <Card
                key={rule.id}
                title={
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900">{rule.name}</span>
                    <Badge tone={ACTION_TONES[rule.actions.action]}>
                      {ACTION_LABELS[rule.actions.action]}
                    </Badge>
                    {!rule.active && <Badge tone="amber">Inactive</Badge>}
                  </div>
                }
                description={`Priority: ${rule.priority}`}
                actions={
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      className="px-2.5 py-1 text-xs"
                      onClick={() => toggleActiveMutation.mutate({ id: rule.id, active: !rule.active })}
                      loading={toggleActiveMutation.isPending && toggleActiveMutation.variables?.id === rule.id}
                    >
                      {rule.active ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      variant="secondary"
                      className="px-2.5 py-1 text-xs"
                      onClick={() => handleOpenEdit(rule)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2.5 py-1 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
                      onClick={() => {
                        if (confirm(`Delete rule "${rule.name}"?`)) {
                          deleteMutation.mutate(rule.id);
                        }
                      }}
                      loading={deleteMutation.isPending && deleteMutation.variables === rule.id}
                    >
                      Delete
                    </Button>
                  </div>
                }
              >
                <div className="text-sm text-slate-600 space-y-1">
                  <p className="font-medium text-slate-700">Conditions:</p>
                  <ul className="list-disc list-inside space-y-0.5 text-slate-600 pl-1 text-xs">
                    {rule.conditions.customerName && (
                      <li>Customer matches: <strong>{rule.conditions.customerName}</strong></li>
                    )}
                    {rule.conditions.maxOrderValue != null && (
                      <li>Order value must be &le; <strong>&pound;{rule.conditions.maxOrderValue.toLocaleString()}</strong></li>
                    )}
                    {rule.conditions.minConfidence != null && (
                      <li>Confidence must be &ge; <strong>{Math.round(rule.conditions.minConfidence * 100)}%</strong></li>
                    )}
                    {rule.conditions.requireTrustedCustomer && (
                      <li>Customer must have <strong>trusted for auto-approval</strong> flag set</li>
                    )}
                    {rule.conditions.requireAllLinesLearned && (
                      <li>All lines must be matched via learned cross-reference or exact SKU</li>
                    )}
                    {rule.conditions.requireNoIssues && (
                      <li>Order must have zero unresolved warnings/issues</li>
                    )}
                    {!rule.conditions.customerId &&
                      rule.conditions.maxOrderValue == null &&
                      rule.conditions.minConfidence == null &&
                      !rule.conditions.requireTrustedCustomer &&
                      !rule.conditions.requireAllLinesLearned &&
                      !rule.conditions.requireNoIssues && (
                        <li className="italic text-slate-400">Applies to all clean orders</li>
                      )}
                  </ul>
                  {rule.actions.reason && (
                    <p className="pt-2 text-xs text-slate-500">
                      <strong>Reason / note:</strong> {rule.actions.reason}
                    </p>
                  )}
                </div>
              </Card>
            ))
          )}
        </div>
      )}

      {/* Create / Edit Rule Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingRule ? 'Edit Rule' : 'Create Automation Rule'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <TextField
            label="Rule Name"
            placeholder="e.g. Auto-approve low value clean orders"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />

          <SelectField
            label="Action"
            value={action}
            onChange={(e) => setAction(e.target.value as RuleAction)}
            options={[
              { value: 'auto_approve', label: 'Auto-Approve & Push to ERP' },
              { value: 'require_review', label: 'Require Manual Review' },
              { value: 'block', label: 'Block Order (Hold)' },
            ]}
          />

          <TextField
            label="Priority (Higher runs first)"
            type="number"
            min="0"
            max="1000"
            value={String(priority)}
            onChange={(e) => setPriority(Number(e.target.value))}
            required
          />

          <div className="pt-2 border-t border-slate-100">
            <h4 className="text-sm font-semibold text-slate-800 mb-2">Conditions</h4>

            <div className="space-y-3">
              <SelectField
                label="Customer Filter"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                options={[
                  { value: '', label: 'All Customers' },
                  ...(customers.data?.items.map((c) => ({
                    value: c.id,
                    label: `${c.name} (${c.accountCode})`,
                  })) ?? []),
                ]}
              />

              <div className="grid grid-cols-2 gap-3">
                <TextField
                  label="Max Order Value (£)"
                  type="number"
                  step="0.01"
                  placeholder="e.g. 500"
                  value={maxValue}
                  onChange={(e) => setMaxValue(e.target.value)}
                  hint="Leave empty for any value"
                />
                <TextField
                  label="Min Confidence (0.0 - 1.0)"
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(e.target.value)}
                />
              </div>

              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={trustedOnly}
                    onChange={(e) => setTrustedOnly(e.target.checked)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>Customer must have <strong>trusted for auto-approve</strong> enabled</span>
                </label>

                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allLearnedOnly}
                    onChange={(e) => setAllLearnedOnly(e.target.checked)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>Require all line items to be learned cross-references or exact SKUs</span>
                </label>

                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={noIssuesOnly}
                    onChange={(e) => setNoIssuesOnly(e.target.checked)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>Require zero unresolved issues or price discrepancies</span>
                </label>
              </div>
            </div>
          </div>

          {(action === 'block' || action === 'require_review') && (
            <TextField
              label="Reason Message"
              placeholder="e.g. Large orders require manager sign-off"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
            <Button variant="secondary" type="button" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={saveMutation.isPending}>
              Save Rule
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
