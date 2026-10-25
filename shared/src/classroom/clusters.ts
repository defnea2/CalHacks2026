// Teacher dashboard clusters: validation and deterministic repair of the LLM's grouping.
//
// Rule (user spec): every active student is in exactly one cluster and every cluster has EXACTLY
// 2 or 4 students. Exceptions, forced by arithmetic: an odd number of students gets exactly one
// cluster of 3; a class of a single student gets one cluster of 1. Pure TS (module + tests).

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
}

/** Allowed cluster sizes for a class of `n` students. */
export function sizeRule(n: number): { allowOneThree: boolean; single: boolean } {
  return { allowOneThree: n % 2 === 1 && n >= 3, single: n === 1 };
}

/** One human-readable sentence of the size rule for the prompt. */
export function sizeRuleText(n: number): string {
  if (n === 1) return 'There is 1 student: one cluster with that student.';
  if (n === 3) return 'There are 3 students: exactly one cluster of 3.';
  if (n % 2 === 0) return `There are ${n} students: every cluster has exactly 2 or 4 students.`;
  return `There are ${n} students (odd): exactly one cluster has 3 students, every other cluster has exactly 2 or 4.`;
}

/** Checks the rules; returns the list of violations (empty = valid). */
export function clusterViolations(clusters: Cluster[], studentIds: string[]): string[] {
  const out: string[] = [];
  const known = new Set(studentIds);
  const seen = new Map<string, number>();
  let threes = 0;
  clusters.forEach((c, i) => {
    for (const id of c.learnerIds) {
      if (!known.has(id)) out.push(`cluster ${i} has unknown student ${id}`);
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    const size = c.learnerIds.length;
    if (size === 3) threes++;
    const n = studentIds.length;
    const ok = size === 2 || size === 4 || (size === 3 && sizeRule(n).allowOneThree) || (size === 1 && sizeRule(n).single);
    if (!ok) out.push(`cluster ${i} has ${size} students`);
  });
  if (threes > 1) out.push(`${threes} clusters of 3 (max one)`);
  for (const id of studentIds) {
    const k = seen.get(id) ?? 0;
    if (k === 0) out.push(`student ${id} is in no cluster`);
    if (k > 1) out.push(`student ${id} is in ${k} clusters`);
  }
  return out;
}

interface Piece {
  ids: string[];
  origin: number; // index of the LLM cluster it came from (-1: none)
}

/**
 * Makes `raw` satisfy the rules with as few changes as possible, deterministically:
 * 1. unknown ids are dropped, duplicates keep their first cluster, missing students become
 *    leftovers; 2. clusters of 2/4 stay; larger ones are cut into 4s (+ a 2 or the one allowed
 *    3); a 3 stays only as the single allowed 3, otherwise it gives up one student; singles are
 *    leftovers; 3. leftovers are sorted by similarity (phase, topic, origin cluster, id) and
 *    paired neighbour by neighbour; an odd leftover joins the most similar pair (making the one 3).
 */
export function repairClusters(raw: Cluster[], students: ClusterStudent[]): RepairResult {
  const ids = students.map(s => s.id);
  const byId = new Map(students.map(s => [s.id, s]));
  const repairs: string[] = [];
  if (clusterViolations(raw, ids).length === 0) {
    return { clusters: raw.map(c => ({ ...c, learnerIds: [...c.learnerIds] })), valid: true, repairs };
  }
  const n = ids.length;
  if (n === 0) return { clusters: [], valid: false, repairs: ['no students: clusters cleared'] };
  const rule = sizeRule(n);

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
  const kept: Array<{ cluster: Cluster; origin: number }> = [];
  let threeUsed = false;
  cleaned.forEach((c, origin) => {
    let rest = [...c.learnerIds];
    const size = rest.length;
    if (size === 0) return;
    if (size === 2 || size === 4) {
      kept.push({ cluster: c, origin });
      return;
    }
    if (size === 1 && rule.single) {
      kept.push({ cluster: c, origin });
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
      if (rule.allowOneThree && !threeUsed) {
        parts.push(rest.slice(0, 3), rest.slice(3));
        threeUsed = true;
      } else {
        parts.push(rest.slice(0, 4));
        leftovers.push({ ids: rest.slice(4), origin });
      }
    } else if (rest.length === 3) {
      if (rule.allowOneThree && !threeUsed) {
        parts.push(rest);
        threeUsed = true;
      } else {
        parts.push(rest.slice(0, 2));
        leftovers.push({ ids: rest.slice(2), origin });
      }
    } else if (rest.length === 2) {
      parts.push(rest);
    } else if (rest.length === 1) {
      leftovers.push({ ids: rest, origin });
    }
    parts.forEach((p, k) => kept.push({ cluster: { ...c, name: parts.length > 1 ? `${c.name} ${k + 1}` : c.name, learnerIds: p }, origin }));
  });

  // 3. pair leftovers by similarity
  const key = (p: Piece) => {
    const s = byId.get(p.ids[0]!)!;
    return [s.phase, s.topic, String(p.origin + 1).padStart(4, '0'), s.id.padStart(20, '0')].join('\u0000');
  };
  const singles = leftovers.flatMap(p => p.ids.map(id => ({ ids: [id], origin: p.origin }))).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const describe = (piece: Piece[]): Cluster => {
    const origin = piece.find(p => p.origin >= 0)?.origin ?? -1;
    const first = byId.get(piece[0]!.ids[0]!)!;
    const base = origin >= 0 ? cleaned[origin]! : undefined;
    return {
      name: base?.name || first.phase || 'Mixed',
      description: base?.description || `Working on ${first.topic || 'the class task'} (${first.phase || 'starting'}).`,
      learnerIds: piece.flatMap(p => p.ids),
    };
  };
  const pairs: Cluster[] = [];
  for (let i = 0; i + 1 < singles.length; i += 2) pairs.push(describe([singles[i]!, singles[i + 1]!]));
  if (singles.length % 2 === 1) {
    const odd = singles[singles.length - 1]!;
    if (rule.single) pairs.push(describe([odd]));
    else if (pairs.length > 0 && !threeUsed) {
      pairs[pairs.length - 1]!.learnerIds.push(odd.ids[0]!); // neighbour in similarity order
      threeUsed = true;
    } else {
      // Join the most similar kept cluster of 2 (it becomes the one allowed 3); if that is taken
      // (cannot happen with correct parity) fall back to the first cluster of 2.
      const s = byId.get(odd.ids[0]!)!;
      const score = (c: Cluster) => c.learnerIds.reduce((acc, id) => acc + (byId.get(id)!.phase === s.phase ? 2 : 0) + (byId.get(id)!.topic === s.topic ? 1 : 0), 0);
      const twos = kept.filter(k => k.cluster.learnerIds.length === 2);
      if (twos.length && !threeUsed) {
        let best = twos[0]!;
        for (const k of twos) if (score(k.cluster) > score(best.cluster)) best = k;
        best.cluster = { ...best.cluster, learnerIds: [...best.cluster.learnerIds, odd.ids[0]!] };
        threeUsed = true;
      } else {
        // Only clusters of 4 (or a 3 already): break a 4 into 2 + 2 and make one of them a 3.
        const four = kept.find(k => k.cluster.learnerIds.length === 4);
        if (four) {
          const [a, b, c2, d] = four.cluster.learnerIds;
          four.cluster = { ...four.cluster, learnerIds: [a!, b!, odd.ids[0]!] };
          kept.push({ cluster: { ...four.cluster, name: `${four.cluster.name} 2`, learnerIds: [c2!, d!] }, origin: four.origin });
        } else pairs.push(describe([odd]));
      }
    }
  }

  const clusters = [...kept.map(k => k.cluster), ...pairs].map(c => ({ ...c, learnerIds: [...c.learnerIds] }));
  return { clusters, valid: false, repairs };
}
