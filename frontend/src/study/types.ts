// Study area content types (T#963).
// Content is static, typed data rendered by RichText as React elements.
// No HTML strings and no dangerouslySetInnerHTML anywhere in the study area.

export type Inline = string | { b: string } | { term: string };
export type Block = { p: Inline[] } | { ul: Inline[][] } | { tip: Inline[] } | { code: string };

export interface Concept {
  t: string;
  b: Block[];
  say: string;
}

export interface QuizQuestion {
  q: string;
  o: string[];
  a: number;
  w: string;
}

export interface Drill {
  p: string;
  m: Block[];
}

export interface StudyModule {
  id: string;
  name: string;
  lede: string;
  concepts: Concept[];
  quiz: QuizQuestion[];
  drills: Drill[];
}

// Bootcamp (T#967): a hands-on lab is a goal, steps, and a "done when" check.
export interface Lab {
  t: string;
  day: string;
  goal: string;
  steps: Block[];
  done: string;
}

export interface BootModule extends StudyModule {
  week: string;
  labs: Lab[];
}

// A module that is planned but not written yet: shown in the outline only.
export interface PlannedModule {
  id: string;
  name: string;
  week: string;
  lede: string;
}
