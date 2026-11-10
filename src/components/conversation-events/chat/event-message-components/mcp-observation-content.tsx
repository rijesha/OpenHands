import { MarkdownRenderer } from "../../../features/markdown/markdown-renderer";

// Only inline images are rendered: a tool result must not make the browser
// fetch an arbitrary URL.
const INLINE_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,/;

interface McpObservationContentProps {
  /** The result as markdown (tool name and text blocks). */
  text: string;
  /** `image_urls` of the result's image blocks. */
  imageUrls: string[];
  /** Names the images for assistive tech (the tool that returned them). */
  label: string;
}

/** An MCP tool result with its text and the images the tool returned (e.g. a VM screenshot). */
export function McpObservationContent({
  text,
  imageUrls,
  label,
}: McpObservationContentProps) {
  const images = imageUrls.filter((url) => INLINE_IMAGE.test(url));

  return (
    <div className="flex flex-col gap-2">
      <MarkdownRenderer>{text}</MarkdownRenderer>
      {images.map((url, index) => (
        <a
          key={url.slice(-64) + index}
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          <img
            src={url}
            alt={label}
            data-testid="mcp-observation-image"
            className="max-h-80 w-auto max-w-full rounded-md border border-border"
          />
        </a>
      ))}
    </div>
  );
}
