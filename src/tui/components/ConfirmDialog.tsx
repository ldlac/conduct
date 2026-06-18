import React from "react";
import { Box, Text } from "ink";

interface Props {
  message: string;
}

export function ConfirmDialog({ message }: Props) {
  return (
    <Box
      width="100%"
      height="100%"
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
        <Text bold color="yellow">
          ⚠  Confirm
        </Text>
        <Box marginY={1}>
          <Text>{message}</Text>
        </Box>
        <Text dimColor>y/yes · n/No (or Esc to cancel)</Text>
      </Box>
    </Box>
  );
}
