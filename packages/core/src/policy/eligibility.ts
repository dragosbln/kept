// Eligibility rules: the gate in front of the caps. A rule reads canonical
// order fields and the line's counting records, never the prompt and never
// the backend's own bookkeeping. Every enabled rule runs on every request so
// the decision record shows all verdicts, not the first failure.

import type {
  EligibilityContext,
  EligibilityFailure,
  EligibilityRuleKind,
  EligibilityRulesEnabled,
  EligibilityVerdict,
} from './types.js';

type EligibilityRule = (ctx: EligibilityContext) => EligibilityVerdict;

function verdict(ruleKind: EligibilityRuleKind, reason?: EligibilityFailure): EligibilityVerdict {
  return reason === undefined ? { ruleKind, passed: true } : { ruleKind, passed: false, reason };
}

export const ELIGIBILITY_RULES: Record<EligibilityRuleKind, EligibilityRule> = {
  // Delivered, not shipped: goods in transit are not refundable here. Summed
  // across shipments, because a line can be split (order-1002 line 1 is
  // delivered one-and-one across two shipments). The two "exceeds" reasons
  // are kept apart on purpose: the first is a true ineligibility, the second
  // means an earlier request already holds the units, and the engine maps
  // it to already_requested so the customer is not told the item is
  // ineligible when it is merely under review.
  item_not_delivered: ({ order, orderItemId, quantity, lineRecords }) => {
    const delivered = order.shipments
      .filter((shipment) => shipment.status === 'delivered')
      .flatMap((shipment) => shipment.items)
      .filter((item) => item.orderItemId === orderItemId)
      .reduce((sum, item) => sum + item.quantity, 0);
    if (delivered === 0) {
      return verdict('item_not_delivered', 'nothing_delivered_on_line');
    }
    if (quantity > delivered) {
      return verdict('item_not_delivered', 'requested_exceeds_delivered');
    }
    // Counting records reserve units the way they reserve amount: pending,
    // attempted, ok and unknown all hold theirs until settled or denied.
    const reserved = lineRecords.reduce((sum, record) => sum + record.quantity, 0);
    if (reserved + quantity > delivered) {
      return verdict('item_not_delivered', 'requested_exceeds_delivered_minus_reserved');
    }
    return verdict('item_not_delivered');
  },
};

/** All rules on. The week-4 fault toggles flip these per run. */
export const DEFAULT_ELIGIBILITY_RULES_ENABLED: EligibilityRulesEnabled = {
  item_not_delivered: true,
};
