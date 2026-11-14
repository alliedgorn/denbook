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

// Lab toolbox (Gorn 11-14: "lab tells me to do things I don't know, and doesn't say where
// to look"). What you'll need for a lab: each tool is a name, one line on what it is for,
// and an optional tiny example that shows the tool, not the answer. Docs are fixed
// https links written here in the source, never user input.
export interface LabTool {
  name: string;
  use: string;
  code?: string;
}

export interface DocLink {
  label: string;
  url: string;
}

// Bootcamp (T#967): a hands-on lab is a goal, steps, and a "done when" check.
export interface Lab {
  t: string;
  day: string;
  goal: string;
  steps: Block[];
  done: string;
  tools?: LabTool[];
  docs?: DocLink[];
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
