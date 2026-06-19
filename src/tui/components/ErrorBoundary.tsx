import React, { Component } from "react";
import { Box, Text } from "ink";

interface Props {
  children: React.ReactNode;
  /** Label to identify the wrapped component in the error report. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log to stderr so it survives the TUI frame but doesn't vanish.
    const tag = this.props.label ?? "component";
    console.error(`conduct: ${tag} crashed —`, error.message, info.componentStack ?? "");
  }

  render() {
    if (this.state.error) {
      return (
        <Box
          flexDirection="column"
          paddingX={1}
          paddingY={1}
          borderStyle="round"
          borderColor="red"
        >
          <Text bold color="red">
            ⚠ {this.props.label ?? "Component"} crashed
          </Text>
          <Text dimColor>{this.state.error.message}</Text>
          <Text dimColor>Press any key to dismiss and continue.</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
