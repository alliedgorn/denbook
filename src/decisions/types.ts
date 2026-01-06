/**
 * Oracle Decision Tracking Types
 *
 * Structured decision tracking with lifecycle states.
 * pending → parked → researching → decided → implemented → closed
 */

// ============================================================================
// Decision Status & Types
// ============================================================================

export type DecisionStatus =
  | 'pending'      // New, needs attention
  | 'parked'       // Intentionally deferred
  | 'researching'  // Gathering info
  | 'decided'      // Choice made
  | 'implemented'  // Built/deployed
  | 'closed';      // Done, archived

export interface DecisionOption {
  label: string;
  pros: string[];
  cons: string[];
}

export interface Decision {
  id: number;
  title: string;
  status: DecisionStatus;
  context: string | null;           // Why this decision matters
  options: DecisionOption[] | null; // Parsed JSON
  decision: string | null;          // What was decided
  rationale: string | null;         // Why this choice
  project: string | null;           // ghq path
  tags: string[] | null;            // Parsed JSON
  createdAt: number;
  updatedAt: number;
  decidedAt: number | null;         // When status → decided
  decidedBy: string | null;         // user or model name
}

// ============================================================================
// Input/Output Interfaces
// ============================================================================

export interface CreateDecisionInput {
  title: string;
  context?: string;
  options?: DecisionOption[];
  tags?: string[];
  project?: string;
}

export interface UpdateDecisionInput {
  id: number;
  title?: string;
  context?: string;
  options?: DecisionOption[];
  decision?: string;
  rationale?: string;
  tags?: string[];
  status?: DecisionStatus;
  decidedBy?: string;
}

export interface ListDecisionsInput {
  status?: DecisionStatus;
  project?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface ListDecisionsOutput {
  decisions: Decision[];
  total: number;
}

// ============================================================================
// Status Transition Validation
// ============================================================================

/**
 * Valid status transitions
 * Most states can go back to earlier stages
 */
export const validTransitions: Record<DecisionStatus, DecisionStatus[]> = {
  pending: ['parked', 'researching', 'decided', 'closed'],
  parked: ['pending', 'researching', 'decided'],
  researching: ['pending', 'parked', 'decided'],
  decided: ['researching', 'implemented', 'closed'],
  implemented: ['decided', 'closed'],
  closed: ['pending', 'implemented'], // can reopen
};

/**
 * Check if a status transition is valid
 */
export function isValidTransition(
  from: DecisionStatus,
  to: DecisionStatus
): boolean {
  return validTransitions[from]?.includes(to) ?? false;
}

/**
 * Get human-readable status description
 */
export function getStatusDescription(status: DecisionStatus): string {
  const descriptions: Record<DecisionStatus, string> = {
    pending: 'New, needs attention',
    parked: 'Intentionally deferred',
    researching: 'Gathering information',
    decided: 'Choice has been made',
    implemented: 'Built and deployed',
    closed: 'Done, archived',
  };
  return descriptions[status];
}
