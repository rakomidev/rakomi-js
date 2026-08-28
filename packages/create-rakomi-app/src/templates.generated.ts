// SPDX-License-Identifier: MIT

/** A quickstart template slug accepted by the scaffolder. */
export type TemplateSlug = "nextjs" | "react" | "node" | "expo";

/** A scaffoldable quickstart template, baked in from the shared manifest at build time. */
export interface Template {
  readonly slug: TemplateSlug;
  readonly label: string;
  /** Public source repository as "owner/name". */
  readonly publicRepo: string;
}

/** The full set of templates, in manifest order. */
export const TEMPLATES: readonly Template[] = [
  { slug: "nextjs", label: "Next.js quickstart", publicRepo: "rakomidev/rakomi-nextjs-quickstart" },
  { slug: "react", label: "React quickstart", publicRepo: "rakomidev/rakomi-react-quickstart" },
  { slug: "node", label: "Node quickstart", publicRepo: "rakomidev/rakomi-node-quickstart" },
  { slug: "expo", label: "Expo quickstart", publicRepo: "rakomidev/rakomi-expo-quickstart" },
];
