export type Axis = "x" | "y" | "z";
export type Curve =
  | { kind: "constant"; value: number }
  | {
      kind: "sine";
      amplitude: number;
      cycles: number;
      phase?: number;
      offset?: number;
    }
  | {
      kind: "keys";
      points: [number, number][];
      interpolation?: "smooth" | "linear" | "hold";
    };
export interface CurveNode {
  id: string;
  kind: "curve";
  label: string;
  target: string;
  axis: Axis;
  channel: "rotation" | "position";
  duration: number;
  curve: Curve;
  blend?: "add" | "replace";
}
export interface GroupNode {
  id: string;
  kind: "sequence" | "parallel" | "repeat";
  label: string;
  children: MotionNode[];
  count?: number;
}
interface ContactBase {
  id: string;
  kind: "contact";
  label: string;
  duration: number;
}
export type ContactNode = ContactBase &
  (
    | { mode: "fingertips"; effector: string; target: string; weight: Curve }
    | {
        mode: "prop_transfer";
        prop: string;
        from: string;
        to: string;
        progress: Curve;
        rolls?: number;
        rollOffset?: number;
        visibility?: Curve;
      }
  );
export interface MotionProp {
  id: string;
  kind: "coin";
  radius: number;
  thickness: number;
}
export type MotionNode = CurveNode | ContactNode | GroupNode;
export interface MotionProgram {
  version: 2;
  title: string;
  bpm: number;
  root: MotionNode;
  props?: MotionProp[];
}
export interface Track extends CurveNode {
  start: number;
  ancestors: string[];
}
export type ContactTrack = ContactNode & { start: number; ancestors: string[] };
export type ContactValue =
  | { mode: "fingertips"; effector: string; target: string; weight: number }
  | {
      mode: "prop_transfer";
      prop: string;
      from: string;
      to: string;
      progress: number;
      rolls: number;
      rollOffset?: number;
      visibility?: number;
    };
export interface Timeline {
  tracks: Track[];
  duration: number;
  contacts?: ContactTrack[];
  props?: MotionProp[];
}
export interface PoseValue {
  target: string;
  axis: Axis;
  channel: "rotation" | "position";
  value: number;
}
export const AXES: Axis[] = ["x", "y", "z"];
