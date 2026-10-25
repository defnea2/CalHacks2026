// Teacher dashboard clusters: validation and deterministic repair of the LLM's grouping.
//
// Rule (user spec): every cluster has EXACTLY 2 or 4 students, never 1 or 3. In an even class
// every active student is in exactly one cluster; in an odd class exactly one student is in no
// cluster (the dashboard shows that student in a "Not grouped yet" slot); a class of a single
// student has no cluster at all. Pure TS (module + tests).

export interface ClusterStudent {
  id: string;
  /** Similarity features for repairs (students with equal keys are paired first). */
  phase: string;
  topic: string;
}

export interface Cluster {
  name: string;
  description: string;
  learnerIds: string[];
}

export interface RepairResult {
  clusters: Cluster[];
  /** True when the input already satisfied every rule (nothing changed). */
  valid: boolean;
  /** Human-readable list of what was repaired (logs). */
  repairs: string[];
  /** Students in no cluster: none for an even class, exactly one for an odd class. */
  ungrouped: string[];
}

/** Every allowed multiset of cluster sizes for n students (largest first), at most `limit`. An odd class groups n - 1. */
export function sizePartitions(n: number, limit = 4): number[][] {
  const even = n - (n % 2);
  if (even <= 0) return [];
  const out: number[][] = [];
  for (let fours = Math.floor(even / 4); fours >= 0 && out.length < limit; fours--) {
    const left = even - fours * 4;
    out.push([...Array(fours).fill(4), ...Array(left / 2).fill(2)]);
  }
  return out;
}

/** The size rule for the prompt, with the allowed size combinations for this class. */
export function sizeRuleText(n: number): string {
  const ex = sizePartitions(n)
    .map(p => p.join('+'))
    .join(' or ');
  if (n === 1) return 'There is 1 student: return no clusters (a single student is not grouped).';
  if (n % 2 === 0) return `There are ${n} students: every student is in exactly one cluster; every cluster has exactly 2 or 4 students, never 1 or 3 (allowed: ${ex}).`;
  return `There are ${n} students (odd): leave exactly one student out of all clusters (the one least like the others; the teacher sees them as not grouped yet); every other student is in exactly one cluster; every cluster has exactly 2 or 4 students, never 1 or 3 (allowed: ${ex}).`;
}

/** Students of the class in no cluster. */
export function ungroupedOf(clusters: Cluster[], studentIds: string[]): string[] {
  const grouped = new Set(clusters.flatMap(c => c.learnerIds));
  return studentIds.filter(id => !grouped.has(id));
}

/** Checks the rules; returns the list of violations (empty = valid). */
export function clusterViolations(clusters: Cluster[], studentIds: string[]): string[] {
  const out: string[] = [];
  const known = new Set(studentIds);
  const seen = new Map<string, number>();
  clusters.forEach((c, i) => {
    for (const id of c.learnerIds) {
      if (!known.has(id)) out.push(`cluster ${i} has unknown student ${id}`);
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    const size = c.learnerIds.length;
    if (size !== 2 && size !== 4) out.push(`cluster ${i} has ${size} students`);
  });
  for (const id of studentIds) {
    const k = seen.get(id) ?? 0;
    if (k > 1) out.push(`student ${id} is in ${k} clusters`);
  }
  const missing = studentIds.filter(id => !seen.has(id));
  const allowed = studentIds.length % 2; // 1 in an odd class
  if (missing.length > allowed) for (const id of missing) out.push(`student ${id} is in no cluster`);
  if (missing.length < allowed) out.push('odd class: exactly one student must stay ungrouped');
  return out;
}

interface Piece {
  ids: string[];
  origin: number; // index of the LLM cluster it came from (-1: none)
}

/**
 * Makes `raw` satisfy the rules with as few changes as possible, deterministically:
 * 1. unknown ids are dropped, duplicates keep their first cluster, missing students become
 *    leftovers; 2. clusters of 2/4 stay; larger ones are cut into 4s (+ a 2); a 3 or 5 gives up
 *    one student; singles are leftovers; 3. leftovers are sorted by similarity (phase, topic,
 *    origin cluster, id) and paired neighbour by neighbour; the odd leftover of an odd class
 *    stays ungrouped (never a cluster of 1 or 3).
 */
export function repairClusters(raw: Cluster[], students: ClusterStudent[]): RepairResult {
  const ids = students.map(s => s.id);
  const byId = new Map(students.map(s => [s.id, s]));
  const repairs: string[] = [];
  if (clusterViolations(raw, ids).length === 0) {
    return { clusters: raw.map(c => ({ ...c, learnerIds: [...c.learnerIds] })), valid: true, repairs, ungrouped: ungroupedOf(raw, ids) };
  }
  if (ids.length === 0) return { clusters: [], valid: false, repairs: ['no students: clusters cleared'], ungrouped: [] };

  // 1. sanitize
  const used = new Set<string>();
  const cleaned: Cluster[] = raw.map(c => {
    const keep: string[] = [];
    for (const id of c.learnerIds) {
      if (!byId.has(id)) {
        repairs.push(`dropped unknown ${id}`);
        continue;
      }
      if (used.has(id)) {
        repairs.push(`dropped duplicate ${id}`);
        continue;
      }
      used.add(id);
      keep.push(id);
    }
    return { ...c, learnerIds: keep };
  });
  const leftovers: Piece[] = [];
  for (const id of ids) {
    if (!used.has(id)) {
      repairs.push(`missing ${id}`);
      leftovers.push({ ids: [id], origin: -1 });
    }
  }

  // 2. keep/cut
  const kept: Cluster[] = [];
  cleaned.forEach((c, origin) => {
    let rest = [...c.learnerIds];
    const size = rest.length;
    if (size === 0) return;
    if (size === 2 || size === 4) {
      kept.push(c);
      return;
    }
    repairs.push(`cluster "${c.name}" had ${size}`);
    const parts: string[][] = [];
    while (rest.length >= 6 || rest.length === 4) {
      parts.push(rest.slice(0, 4));
      rest = rest.slice(4);
    }
    // rest is now 0, 1, 2, 3 or 5
    if (rest.length === 5) {
      parts.push(rest.slice(0, 4));
      leftovers.push({ ids: rest.slice(4), origin });
    } else if (rest.length === 3) {
      parts.push(rest.slice(0, 2));
      leftovers.push({ ids: rest.slice(2), origin });
    } else if (rest.length === 2) {
      parts.push(rest);
    } else if (rest.length === 1) {
      leftovers.push({ ids: rest, origin });
    }
    parts.forEach((p, k) => kept.push({ ...c, name: parts.length > 1 ? `${c.name} ${k + 1}` : c.name, learnerIds: p }));
  });

  // 3. pair leftovers by similarity; with an odd class the last one stays ungrouped
  const key = (p: Piece) => {
    const s = byId.get(p.ids[0]!)!;
    return [s.phase, s.topic, String(p.origin + 1).padStart(4, '0'), s.id.padStart(20, '0')].join('\u0000');
  };
  const singles = leftovers.flatMap(p => p.ids.map(id => ({ ids: [id], origin: p.origin }))).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const describe = (piece: Piece[]): Cluster => {
    const first = byId.get(piece[0]!.ids[0]!)!;
    // Merged from different LLM clusters: both names / descriptions (each is short).
    const bases = [...new Set(piece.map(p => p.origin).filter(o => o >= 0))].map(o => cleaned[o]!);
    return {
      name: bases.map(b => b.name).filter(Boolean).join(' · ') || first.phase || 'Mixed',
      description: bases.map(b => b.description).filter(Boolean).join(' ') || `Working on ${first.topic || 'the class task'} (${first.phase || 'starting'}).`,
      learnerIds: piece.flatMap(p => p.ids),
    };
  };
  const pairs: Cluster[] = [];
  for (let i = 0; i + 1 < singles.length; i += 2) pairs.push(describe([singles[i]!, singles[i + 1]!]));
  // Parity: kept clusters are all even, so an odd leftover count means an odd class.
  const ungrouped = singles.length % 2 === 1 ? [singles[singles.length - 1]!.ids[0]!] : [];
  if (ungrouped.length) repairs.push(`ungrouped ${ungrouped[0]}`);

  const clusters = [...kept, ...pairs].map(c => ({ ...c, learnerIds: [...c.learnerIds] }));
  return { clusters, valid: false, repairs, ungrouped };
}
