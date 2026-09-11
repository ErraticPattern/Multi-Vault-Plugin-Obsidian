import type { UnresolvedLinkPlan } from './unresolved-link-planner';

export interface SelectedResolution { groupId: string; candidateId: string }

export class UnresolvedLinksViewModel {
  private readonly choices = new Map<string, string>();
  private readonly enabled = new Set<string>();

  constructor(readonly plan: UnresolvedLinkPlan) {
    this.selectAllUnambiguous();
  }

  choose(groupId: string, candidateId: string): void {
    const group = this.plan.groups.find(item => item.id === groupId);
    if (!group?.candidates.some(candidate => candidate.id === candidateId)) return;
    this.choices.set(groupId, candidateId);
    this.enabled.add(groupId);
  }

  setEnabled(groupId: string, enabled: boolean): void {
    if (enabled && this.choices.has(groupId)) this.enabled.add(groupId);
    else this.enabled.delete(groupId);
  }

  isEnabled(groupId: string): boolean { return this.enabled.has(groupId); }
  choice(groupId: string): string | undefined { return this.choices.get(groupId); }

  clear(): void { this.enabled.clear(); }

  selectAllUnambiguous(): void {
    for (const group of this.plan.groups) {
      if (group.candidates.length !== 1) continue;
      this.choices.set(group.id, group.candidates[0].id);
      this.enabled.add(group.id);
    }
  }

  selected(): SelectedResolution[] {
    return this.plan.groups.flatMap(group => {
      const candidateId = this.choices.get(group.id);
      return this.enabled.has(group.id) && candidateId ? [{ groupId: group.id, candidateId }] : [];
    });
  }
}
