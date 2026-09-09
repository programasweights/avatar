import type { Curve, CurveNode } from "./types";
export default function CurveEditor({
  node,
  onChange,
}: {
  node: CurveNode;
  onChange: (curve: Curve) => void;
}) {
  const c = node.curve;
  const numeric = (
    label: string,
    value: number,
    set: (value: number) => void,
    step = 1,
  ) => (
    <label>
      {label}
      <input
        aria-label={`Curve ${label}`}
        type="number"
        value={value}
        step={step}
        onChange={(event) => {
          if (
            event.target.value !== "" &&
            Number.isFinite(Number(event.target.value))
          )
            set(Number(event.target.value));
        }}
      />
    </label>
  );
  return (
    <div className="motion-curve-fields">
      <label>
        Shape
        <select
          aria-label="Curve shape"
          value={c.kind}
          onChange={(event) =>
            onChange(
              event.target.value === "constant"
                ? { kind: "constant", value: 0 }
                : event.target.value === "sine"
                  ? {
                      kind: "sine",
                      amplitude: node.channel === "position" ? 0.05 : 30,
                      cycles: 2,
                    }
                  : {
                      kind: "keys",
                      points: [
                        [0, 0],
                        [0.5, node.channel === "position" ? 0.05 : 30],
                        [1, 0],
                      ],
                    },
            )
          }
        >
          <option value="constant">Constant</option>
          <option value="sine">Sine</option>
          <option value="keys">Keyframes</option>
        </select>
      </label>
      {c.kind === "constant" &&
        numeric(
          node.channel === "position" ? "Metres" : "Degrees",
          c.value,
          (value) => onChange({ ...c, value }),
          node.channel === "position" ? 0.01 : 1,
        )}
      {c.kind === "sine" && (
        <>
          {numeric(
            "Amplitude",
            c.amplitude,
            (amplitude) => onChange({ ...c, amplitude }),
            node.channel === "position" ? 0.01 : 1,
          )}
          {numeric(
            "Cycles",
            c.cycles,
            (cycles) => {
              if (Math.abs(cycles) <= 240) onChange({ ...c, cycles });
            },
            0.25,
          )}
          {numeric(
            "Offset",
            c.offset ?? 0,
            (offset) => onChange({ ...c, offset }),
            node.channel === "position" ? 0.01 : 1,
          )}
          {numeric(
            "Phase",
            c.phase ?? 0,
            (phase) => onChange({ ...c, phase }),
            0.05,
          )}
        </>
      )}
      {c.kind === "keys" && (
        <label>
          Interpolation
          <select
            aria-label="Curve interpolation"
            value={c.interpolation ?? "smooth"}
            onChange={(event) =>
              onChange({
                ...c,
                interpolation: event.target.value as
                  | "smooth"
                  | "linear"
                  | "hold",
              })
            }
          >
            <option value="smooth">Smooth</option>
            <option value="linear">Linear</option>
            <option value="hold">Hold</option>
          </select>
        </label>
      )}
    </div>
  );
}
