import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { McpObservationContent } from "./mcp-observation-content";

const TOOL = "desktop_screenshot";

describe("McpObservationContent", () => {
  it("shows inline images and skips any other URL", () => {
    render(
      <McpObservationContent
        text={`**Tool:** ${TOOL}`}
        label={TOOL}
        imageUrls={[
          "data:image/png;base64,AAAA",
          "https://tracker.example/pixel.png",
          "data:text/html;base64,PGI+",
        ]}
      />,
    );

    const images = screen.getAllByTestId("mcp-observation-image");
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(images[0]).toHaveAttribute("alt", TOOL);
  });
});
