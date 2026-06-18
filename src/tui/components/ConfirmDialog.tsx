import React from "react";
import { Box, Text } from "ink";

interface Props {
  message: string;
  width: number;
  height: number;
}

export function ConfirmDialog({ message, width, height }: Props) {
  // Ink only paints `backgroundColor` onto actual text glyphs, never onto a
  // Box's empty cells. A plain `<Box backgroundColor>` therefore leaves the
  // area around the dialog transparent, so the list/detail panes behind it
  // bleed through and overlap. To get a real, opaque backdrop we paint a full
  // grid of background-colored spaces ourselves, then center the dialog on top.
  const blank = " ".repeat(Math.max(0, width));
  return (
    <Box position="absolute" width={width} height={height}>
      <Box position="absolute" flexDirection="column">
        {Array.from({ length: Math.max(0, height) }, (_, i) => (
          <Text key={i} backgroundColor="black">
            {blank}
          </Text>
        ))}
      </Box>
      <Box
        position="absolute"
        width={width}
        height={height}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
      >
        <Box
          flexDirection="column"
          paddingX={2}
          paddingY={1}
          borderStyle="round"
          borderColor="yellow"
          width={60}
        >
          <Text bold color="yellow" backgroundColor="black">
            ⚠  Confirm
          </Text>
          <Box marginY={1}>
            <Text backgroundColor="black">{message}</Text>
          </Box>
          <Text dimColor backgroundColor="black">
            y/yes · n/No (or Esc to cancel)
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
