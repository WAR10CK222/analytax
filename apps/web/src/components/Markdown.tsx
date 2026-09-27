import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "../lib/cx";

const REMARK_PLUGINS = [remarkGfm];

// Raw HTML is not rendered (react-markdown default); links open in a new tab without an opener.
const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
};

export function MarkdownView({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cx("markdown", className)}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {children}
      </Markdown>
    </div>
  );
}
