// Topic prefetch cues: words in a task text (or teacher content) that point to a taxonomy concept.
// Scored by shared/src/lesson/library.ts guessTopic; a tie or no hit leaves the topic to the LLM
// classifier in the worker. Lowercase regular-expression sources, matched on word boundaries.
export const topicCues: Record<string, string[]> = {
  'place-value': ['place value', 'hundreds?', 'thousands?', 'tens and ones', 'digits?', 'round(ing)? to'],
  regrouping: ['carry(ing)?', 'borrow(ing)?', 'regroup(ing)?', 'column (addition|subtraction)', '\\d+ ?[+-] ?\\d{2,}'],
  'multiplication-groups': ['times', 'multipl(y|ication|ied)', 'groups? of', 'rows? of', 'arrays?', '\\d+ ?[x×*] ?\\d+'],
  'division-sharing': ['divid(e|ed|ing)', 'division', 'shar(e|es|ed|ing)', 'equally', 'fairly', 'each (get|gets)', '\\d+ ?[÷:/] ?\\d+ (people|friends|children|kids)'],
  'fractions-unit': ['what (is )?a fraction', 'one (half|third|quarter)', 'unit fractions?', 'numerator', 'denominator'],
  'fractions-compare': ['compare', 'bigger', 'larger', 'smaller', 'greater', 'less than', 'more than', 'which is more', '[<>]'],
  'fractions-expand': ['expand(ing)?', 'equivalent', 'same (amount|value)', '(is )?the same as', 'bottom number is', 'denominator (is|of) \\d+', 'simplif(y|ying)', 'reduce'],
  'fractions-add-same': ['add(ing)? fractions', '\\d+/\\d+ ?\\+ ?\\d+/\\d+', 'plus \\w+ (halves|thirds|quarters|fifths|sixths|eighths|tenths)'],
  'decimals-tenths': ['decimals?', 'tenths?', 'hundredths?', '\\d+\\.\\d+', 'point \\w+'],
  'units-length': ['centimet(er|re)s?', 'met(er|re)s?', 'millimet(er|re)s?', 'kilomet(er|re)s?', '\\bcm\\b', '\\bkm\\b', 'length'],
  'area-perimeter': ['area', 'perimeter', 'rectangle', 'square units', 'around the (edge|outside)'],
  'bar-charts': ['bar (chart|graph)', 'chart', 'graph', 'tally'],
};
/** Cues that only say "fractions" (category without a concept). */
export const fractionCue = 'numerator|denominator|\\d+/\\d+|fractions?|halves|thirds|quarters|fifths|sixths|eighths|twelfths';
