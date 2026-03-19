// Tracks attack results — records each scenario outcome and provides a summary

export interface SideEffects {
  reputationBefore?: number;
  reputationAfter?: number;
  reputationDelta?: number;
  bondStatus?: string;
  dashboardContainsRawHtml?: boolean;
  additionalNotes?: string;
}

export interface AttackResult {
  scenarioId: string;
  scenarioName: string;
  category: string;
  expectedOutcome: string;
  actualOutcome: string;
  caught: boolean;
  details: string;
  sideEffects?: SideEffects;
}

export class AttackLog {
  private results: AttackResult[] = [];

  record(result: AttackResult): void {
    this.results.push(result);
  }

  getResults(): AttackResult[] {
    return [...this.results];
  }
}
