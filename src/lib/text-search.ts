const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "where", "which", "who", "with", "we", "our", "do", "does", "must", "should",
]);

const DOMAIN_ACRONYMS = new Set(["rp", "ot", "fba", "fca", "bsp", "pbs", "ndis", "ndia"]);

const TOKEN_EXPANSIONS: Record<string, string[]> = {
  onboarding: ["commencement", "intake", "referral", "start"],
  commencement: ["onboarding", "intake", "referral", "start"],
  intake: ["onboarding", "commencement", "referral"],
  referral: ["intake", "onboarding", "commencement"],
  template: ["form"],
  form: ["template"],
  agreement: ["contract", "consent"],
  contract: ["agreement"],
  incident: ["report", "notify", "notification"],
  notification: ["notify", "report", "incident"],
  consent: ["permission", "authorisation", "authorization", "agreement"],
  permission: ["consent", "authorisation", "authorization"],
  authorisation: ["authorization", "consent", "permission"],
  authorization: ["authorisation", "consent", "permission"],
  procedure: ["process", "steps", "workflow"],
  process: ["procedure", "steps", "workflow"],
  workflow: ["procedure", "process", "steps"],
  policy: ["procedure", "requirement", "guideline"],
  guideline: ["policy", "requirement"],
  staff: ["worker", "employee", "practitioner", "team"],
  worker: ["staff", "employee", "practitioner"],
  practitioner: ["staff", "worker", "employee"],
  behaviour: ["behavior"],
  behavior: ["behaviour"],
  restrictive: ["restriction", "restraint", "seclusion"],
  restriction: ["restrictive", "restraint", "seclusion"],
  restraint: ["restrictive", "restriction", "seclusion"],
  breach: ["exposure", "exposed", "privacy"],
  exposure: ["breach", "exposed", "privacy"],
  exposed: ["breach", "exposure", "privacy"],
  complaint: ["grievance", "feedback", "dissatisfied", "unhappy"],
  grievance: ["complaint", "feedback", "dissatisfied"],
  dissatisfied: ["complaint", "grievance", "feedback", "unhappy"],
  unhappy: ["complaint", "grievance", "feedback", "dissatisfied"],
  backup: ["restore", "recovery"],
  restore: ["backup", "recover", "recovery"],
  recover: ["restore", "backup", "recovery"],
  recovery: ["restore", "backup", "recover"],
  hazard: ["risk", "safety"],
  safety: ["hazard", "risk"],
};

type ConceptDefinition = {
  aliases: readonly string[];
  signatures: readonly (readonly string[])[];
  triggers?: readonly (readonly string[])[];
};

const CONCEPTS: readonly ConceptDefinition[] = [
  {
    aliases: ["fba", "functional behaviour assessment", "functional behavior assessment", "functional behavioural assessment", "functional behavioral assessment"],
    signatures: [["fba"], ["behaviour", "assessment"], ["behavior", "assessment"], ["behavioural", "assessment"], ["behavioral", "assessment"]],
    triggers: [["behaviour", "happen"], ["behavior", "happen"], ["behaviour", "function"], ["behavior", "function"], ["behaviour", "cause"], ["behavior", "cause"]],
  },
  {
    aliases: ["fca", "functional capacity assessment"],
    signatures: [["fca"], ["capacity", "assessment"]],
  },
  {
    aliases: ["bsp", "behaviour support plan", "behavior support plan", "positive behaviour support plan", "positive behavior support plan"],
    signatures: [["bsp"], ["behaviour", "support", "plan"], ["behavior", "support", "plan"]],
  },
  {
    aliases: ["pbs", "positive behaviour support", "positive behavior support"],
    signatures: [["pbs"], ["positive", "behaviour", "support"], ["positive", "behavior", "support"]],
  },
  {
    aliases: ["rp", "restrictive practice", "restrictive practices"],
    signatures: [["rp"], ["restrictive", "practice"], ["restriction"], ["restraint"], ["seclusion"]],
  },
  {
    aliases: ["ndis", "national disability insurance scheme"],
    signatures: [["ndis"], ["insurance", "scheme"]],
  },
  {
    aliases: ["ndia", "national disability insurance agency"],
    signatures: [["ndia"], ["insurance", "agency"]],
  },
  {
    aliases: ["data breach", "privacy breach", "information breach", "personal information breach"],
    signatures: [["data", "breach"], ["privacy", "breach"], ["information", "breach"], ["exposure"]],
  },
  {
    aliases: ["implementing provider", "implementation provider", "implementer"],
    signatures: [["implementer"], ["implementing", "provider"], ["implementation", "provider"]],
  },
  {
    aliases: ["complaint", "service complaint", "grievance", "customer feedback"],
    signatures: [["complaint"], ["grievance"], ["feedback"]],
    triggers: [["unhappy", "service"], ["dissatisfied", "service"]],
  },
  {
    aliases: ["backup", "restore", "disaster recovery", "data recovery"],
    signatures: [["backup"], ["restore"], ["recovery"]],
    triggers: [["data", "loss"], ["system", "recover"], ["system", "recovery"]],
  },
  {
    aliases: ["hazard", "risk assessment", "workplace safety", "work health safety"],
    signatures: [["hazard"], ["risk"], ["safety"]],
    triggers: [["workplace", "hazard"], ["workplace", "risk"]],
  },
];

function normaliseText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(normalised: string, phrase: string) {
  const target = normaliseText(phrase);
  return (` ${normalised} `).includes(` ${target} `);
}

export function stemToken(token: string) {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 5 && /(sses|shes|ches|xes|zes)$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function baseTokens(text: string) {
  return normaliseText(text)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => (token.length > 2 || DOMAIN_ACRONYMS.has(token)) && !STOP.has(token))
    .map(stemToken);
}

function expansionsForToken(token: string) {
  const expanded: string[] = [];
  for (const [source, aliases] of Object.entries(TOKEN_EXPANSIONS)) {
    if (baseTokens(source)[0] !== token) continue;
    for (const alias of aliases) expanded.push(...baseTokens(alias));
  }
  return expanded;
}

function triggerMatches(queryTokens: Set<string>, trigger: readonly string[]) {
  const required = trigger.flatMap((part) => baseTokens(part));
  return required.length > 0 && required.every((token) => queryTokens.has(token));
}

export function queryConceptGroups(query: string) {
  const normalisedQuery = normaliseText(query);
  const tokenSet = new Set(baseTokens(query));
  return CONCEPTS
    .filter((concept) =>
      concept.aliases.some((alias) => containsPhrase(normalisedQuery, alias)) ||
      (concept.triggers ?? []).some((trigger) => triggerMatches(tokenSet, trigger)),
    )
    .map((concept) => ({
      tokens: [...new Set(concept.aliases.flatMap((alias) => baseTokens(alias)))],
      signatures: concept.signatures.map((signature) => [...new Set(signature.flatMap((part) => baseTokens(part)))]),
    }));
}

export function queryTokens(query: string) {
  const original = baseTokens(query);
  const expanded = [...original];

  for (const token of original) expanded.push(...expansionsForToken(token));
  for (const concept of queryConceptGroups(query)) expanded.push(...concept.tokens);

  return [...new Set(expanded)];
}
