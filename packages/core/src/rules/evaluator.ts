import { Types } from 'mongoose';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { Customer } from '../models/Customer';
import type { OrderDoc } from '../models/Order';
import { Rule, type IRule } from '../models/Rule';
import { executeOrderPush } from '../connectors/pushJob';
import type { Storage } from '../lib/storage';
import type { FetchLike } from '../mailboxes/oauth';

export type RuleEngineDeps = {
  storage?: Storage;
  fetch?: FetchLike;
};

/**
 * Evaluates active rules against an order in priority order.
 * If an auto-approve rule matches, automatically approves and pushes the order to the active ERP.
 * If a block rule matches, marks the order on_hold with a blocking issue.
 */
export async function evaluateOrderRules(
  deps: RuleEngineDeps,
  order: OrderDoc,
  orgId: Types.ObjectId,
): Promise<{ matched: boolean; rule?: IRule; actionTaken?: string }> {
  const rules = await Rule.find({ orgId, active: true }).sort({ priority: -1, createdAt: 1 });
  if (!rules.length) return { matched: false };

  const customer = order.customerId
    ? await Customer.findOne({ _id: order.customerId, orgId })
    : null;

  for (const rule of rules) {
    const c = rule.conditions;

    // 1. Customer condition
    if (c.customerId && (!order.customerId || !order.customerId.equals(c.customerId))) {
      continue;
    }

    // 2. Trusted customer condition
    if (c.requireTrustedCustomer) {
      if (!customer || !customer.trustedForAutoApprove) {
        continue;
      }
    }

    // 3. Max order value condition
    if (c.maxOrderValue !== undefined && c.maxOrderValue !== null) {
      if (order.value === undefined || order.value > c.maxOrderValue) {
        continue;
      }
    }

    // 4. Min confidence condition
    if (c.minConfidence !== undefined && c.minConfidence !== null) {
      if (order.confidence < c.minConfidence) {
        continue;
      }
    }

    // 5. Require no unresolved issues
    if (c.requireNoIssues) {
      const unresolved = order.issues.filter((i) => !i.resolved);
      if (unresolved.length > 0) {
        continue;
      }
    }

    // 6. Require all lines learned / exact
    if (c.requireAllLinesLearned) {
      const allLearned = order.lines.every((l) =>
        ['xref_code', 'xref_description', 'sku', 'barcode'].includes(l.matchMethod),
      );
      if (!allLearned) {
        continue;
      }
    }

    // Rule matched!
    if (rule.actions.action === 'auto_approve') {
      // Auto-approve only proceeds if there are no unresolved blocking issues
      const hasBlocking = order.issues.some((i) => !i.resolved && i.blocking);
      if (hasBlocking) {
        logger.info(
          { orderId: order._id, ruleName: rule.name },
          'Rule matched auto_approve but order has unresolved blocking issues; skipping auto-approval',
        );
        continue;
      }

      for (const issue of order.issues) {
        issue.resolved = true;
      }
      order.autoApproved = true;
      order.autoApprovedRuleId = rule._id;
      order.autoApprovedRuleName = rule.name;
      order.status = 'approved';
      order.approvedAt = new Date();
      order.version += 1;
      await order.save();

      await audit({
        orgId,
        action: 'order.auto_approved',
        entity: { type: 'order', id: order._id.toString() },
        summary: { ruleId: rule._id.toString(), ruleName: rule.name },
      });

      // Automatically execute push to active ERP connector
      try {
        await executeOrderPush(deps, {
          orgId: orgId.toString(),
          orderId: order._id.toString(),
        });
      } catch (pushErr) {
        logger.error({ err: pushErr, orderId: order._id }, 'Error auto-pushing order to connector');
      }

      return { matched: true, rule, actionTaken: 'auto_approve' };
    }

    if (rule.actions.action === 'block') {
      order.status = 'on_hold';
      order.issues.push({
        _id: new Types.ObjectId(),
        code: 'rule_blocked',
        severity: 'error',
        blocking: true,
        message: rule.actions.reason || `Blocked by rule: ${rule.name}`,
        resolved: false,
      });
      order.version += 1;
      await order.save();

      await audit({
        orgId,
        action: 'order.held',
        entity: { type: 'order', id: order._id.toString() },
        summary: { ruleId: rule._id.toString(), ruleName: rule.name, reason: rule.actions.reason },
      });

      return { matched: true, rule, actionTaken: 'block' };
    }

    if (rule.actions.action === 'require_review') {
      order.status = 'needs_review';
      order.issues.push({
        _id: new Types.ObjectId(),
        code: 'rule_review_required',
        severity: 'warning',
        blocking: false,
        message: rule.actions.reason || `Review required by rule: ${rule.name}`,
        resolved: false,
      });
      order.version += 1;
      await order.save();
      return { matched: true, rule, actionTaken: 'require_review' };
    }
  }

  return { matched: false };
}
