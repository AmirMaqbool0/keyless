import { Router } from 'express';
import {
  createRuleSchema,
  updateRuleSchema,
  type RuleDto,
} from '@keyless/shared';
import { audit } from '@keyless/core/lib/audit';
import { notFound, param, validate } from '@keyless/core/lib/http';
import { Customer } from '@keyless/core/models/Customer';
import { Rule, type IRule } from '@keyless/core/models/Rule';
import { authed, requireRole } from '../../middleware/auth';
import { objectId } from '../shared';

function toDto(r: IRule, customerName?: string | null): RuleDto {
  return {
    id: r._id.toString(),
    name: r.name,
    type: r.type,
    priority: r.priority,
    active: r.active,
    conditions: {
      customerId: r.conditions?.customerId?.toString() ?? null,
      customerName: customerName ?? null,
      maxOrderValue: r.conditions?.maxOrderValue ?? null,
      minConfidence: r.conditions?.minConfidence ?? null,
      requireTrustedCustomer: r.conditions?.requireTrustedCustomer,
      requireAllLinesLearned: r.conditions?.requireAllLinesLearned,
      requireNoIssues: r.conditions?.requireNoIssues,
    },
    actions: {
      action: r.actions?.action ?? 'auto_approve',
      reason: r.actions?.reason ?? null,
    },
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function rulesRouter(): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const { orgId } = authed(req);
    const rules = await Rule.find({ orgId }).sort({ priority: -1, createdAt: 1 });
    const customerIds = [
      ...new Set(
        rules
          .map((x) => x.conditions?.customerId?.toString())
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const customers = customerIds.length
      ? await Customer.find({ orgId, _id: { $in: customerIds } }, { name: 1 })
      : [];
    const customerMap = new Map(customers.map((c) => [c._id.toString(), c.name]));

    const dtos: RuleDto[] = rules.map((rule) => {
      const cId = rule.conditions?.customerId?.toString();
      return toDto(rule, cId ? customerMap.get(cId) : null);
    });
    res.json({ items: dtos });
  });

  r.post('/', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const input = validate(createRuleSchema, req.body);
    const rule = await Rule.create({
      orgId,
      name: input.name,
      type: input.type,
      priority: input.priority,
      active: input.active,
      conditions: {
        customerId: input.conditions.customerId ? objectId(input.conditions.customerId) : undefined,
        maxOrderValue: input.conditions.maxOrderValue ?? undefined,
        minConfidence: input.conditions.minConfidence ?? undefined,
        requireTrustedCustomer: input.conditions.requireTrustedCustomer ?? false,
        requireAllLinesLearned: input.conditions.requireAllLinesLearned ?? false,
        requireNoIssues: input.conditions.requireNoIssues ?? false,
      },
      actions: {
        action: input.actions.action,
        reason: input.actions.reason ?? undefined,
      },
    });

    await audit({
      orgId,
      action: 'rule.created',
      entity: { type: 'rule', id: rule._id.toString() },
      summary: { name: rule.name, type: rule.type },
      req,
    });

    res.status(201).json({ rule: toDto(rule) });
  });

  r.patch('/:id', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const rule = await Rule.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!rule) throw notFound('Rule not found');

    const input = validate(updateRuleSchema, req.body);
    if (input.name) rule.name = input.name;
    if (input.type) rule.type = input.type;
    if (input.priority !== undefined) rule.priority = input.priority;
    if (input.active !== undefined) rule.active = input.active;
    if (input.conditions) {
      rule.conditions = {
        ...rule.conditions,
        ...(input.conditions.customerId !== undefined
          ? {
              customerId: input.conditions.customerId
                ? objectId(input.conditions.customerId)
                : undefined,
            }
          : {}),
        ...(input.conditions.maxOrderValue !== undefined
          ? { maxOrderValue: input.conditions.maxOrderValue ?? undefined }
          : {}),
        ...(input.conditions.minConfidence !== undefined
          ? { minConfidence: input.conditions.minConfidence ?? undefined }
          : {}),
        ...(input.conditions.requireTrustedCustomer !== undefined
          ? { requireTrustedCustomer: input.conditions.requireTrustedCustomer }
          : {}),
        ...(input.conditions.requireAllLinesLearned !== undefined
          ? { requireAllLinesLearned: input.conditions.requireAllLinesLearned }
          : {}),
        ...(input.conditions.requireNoIssues !== undefined
          ? { requireNoIssues: input.conditions.requireNoIssues }
          : {}),
      };
    }
    if (input.actions) {
      rule.actions = {
        action: input.actions.action ?? rule.actions.action,
        reason: input.actions.reason !== undefined ? (input.actions.reason ?? undefined) : rule.actions.reason,
      };
    }

    await rule.save();

    await audit({
      orgId,
      action: 'rule.updated',
      entity: { type: 'rule', id: rule._id.toString() },
      summary: { name: rule.name },
      req,
    });

    res.json({ rule: toDto(rule) });
  });

  r.delete('/:id', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const rule = await Rule.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!rule) throw notFound('Rule not found');

    await Rule.deleteOne({ _id: rule._id, orgId });

    await audit({
      orgId,
      action: 'rule.deleted',
      entity: { type: 'rule', id: rule._id.toString() },
      summary: { name: rule.name },
      req,
    });

    res.status(204).end();
  });

  return r;
}
