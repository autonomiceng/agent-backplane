// executeSql checks catalog facts before switching roles. S07's Migration policy governs column defaults
// (constant defaults only) and constraints.
export type RelationFacts = {
  schema: string; name: string; kind: string; owner: string;
  principalUuid: boolean | null; principalNotNull: boolean | null;
  runUuid: boolean | null; runNotNull: boolean | null;
  generated: boolean; triggerCount: number; stampEnabled: string | null; stampFunction: boolean | null;
  rules: boolean; policies: boolean;
};

export function relationContract(schema: string, relations: string[], facts: RelationFacts[]):
  { ok: true } | { ok: false; reason: "sql_relation_contract" } {
  const valid = relations.every((name) => {
    const relation = facts.find((fact) => fact.schema === schema && fact.name === name);
    return relation !== undefined && relation.kind === "r" && relation.owner === "bp_executor"
      && relation.principalUuid === true && relation.principalNotNull === true
      && relation.runUuid === true && relation.runNotNull === true && !relation.generated
      && relation.triggerCount === 1 && relation.stampEnabled === "A" && relation.stampFunction === true
      && !relation.rules && !relation.policies;
  });
  return valid ? { ok: true } : { ok: false, reason: "sql_relation_contract" };
}
