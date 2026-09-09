import { Component, type ReactNode } from "react";

export default class StageBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    const graphicsError = /webgl|context/i.test(this.state.error.message);
    return (
      <div className="motion-stage-recovery" role="alert">
        <p>
          {graphicsError
            ? "The 3D preview could not start."
            : "The character could not be loaded."}
        </p>
        <p>Your motion is still here. Try loading the preview again.</p>
        <button
          type="button"
          onClick={() => {
            this.props.onRetry();
            this.setState({ error: null });
          }}
        >
          Retry character
        </button>
      </div>
    );
  }
}
