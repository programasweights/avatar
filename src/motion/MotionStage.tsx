import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  ContactShadows,
  Grid,
  OrbitControls,
  useGLTF,
} from "@react-three/drei";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { Quaternion, SkeletonHelper, Vector3 } from "three";
import type { Bone } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Timeline } from "./types";
import { sampleContacts, sampleTimeline } from "./engine";
import { MotionRig } from "./rig";
import { frameHand, frameHandOrbit } from "./handCamera";
import { JointSelection } from "./stageSelection";

export interface Transport {
  time: number;
  playing: boolean;
  loop: boolean;
  duration: number;
}
interface Props {
  timeline: Timeline;
  transport: React.MutableRefObject<Transport>;
  skeleton: boolean;
  focus: "body" | "left_hand" | "right_hand";
  selectedTargets?: string[];
  onTick: (time: number, playing: boolean) => void;
  onReady: () => void;
  onCanvas: (canvas: HTMLCanvasElement) => void;
}
type CameraFrame = { position: Vector3; target: Vector3; up: Vector3 };
const bodyFrame = (): CameraFrame => ({
  position: new Vector3(2.5, 1.8, 4.5),
  target: new Vector3(0, 0.95, 0),
  up: new Vector3(0, 1, 0),
});

// Orbit between views instead of taking a straight shortcut through the hand.
function blendFrame(from: CameraFrame, to: CameraFrame, progress: number) {
  const t = progress * progress * (3 - 2 * progress);
  const start = from.position.clone().sub(from.target);
  const end = to.position.clone().sub(to.target);
  const radius = start.length() * (1 - t) + end.length() * t;
  const rotation = new Quaternion().setFromUnitVectors(
    start.normalize(),
    end.normalize(),
  );
  const direction = start.applyQuaternion(new Quaternion().slerp(rotation, t));
  const target = from.target.clone().lerp(to.target, t);
  const up = from.up.clone().lerp(to.up, t);
  if (up.lengthSq() < 0.0001) up.copy(to.up);
  return {
    position: target.clone().addScaledVector(direction, radius),
    target,
    up: up.normalize(),
  };
}
export function motionHandFrame(
  joints: ReadonlyMap<string, { bone: Bone }>,
  timeline: Timeline,
  side: "left" | "right",
  time = 0,
) {
  if (timeline.tracks.some((track) => track.target === `${side}_hand_camera`)) {
    const angle =
      sampleTimeline(timeline, time).find(
        (value) => value.target === `${side}_hand_camera`,
      )?.value ?? 0;
    return frameHandOrbit(joints, side, angle);
  }
  const wristTracks = timeline.tracks.filter(
    (track) => track.target === `${side}_wrist`,
  );
  const coin = wristTracks.some((track) => track.id.startsWith("coinpose."));
  const raised = wristTracks.some((track) =>
    track.id.startsWith("arms.showcase."),
  );
  if (coin || raised) return frameHand(joints, side, coin);
  // General joint edits can leave the arm hanging beside the torso. Looking
  // straight into that palm crosses the body; retain the original outside,
  // forward camera for the One finger demo and finger edits while dancing.
  const wrist = joints
    .get(`${side}_wrist`)!
    .bone.getWorldPosition(new Vector3());
  const finger = joints
    .get(`${side}_index_3`)!
    .bone.getWorldPosition(new Vector3());
  const target = wrist.lerp(finger, 0.5);
  return {
    position: target
      .clone()
      .add(new Vector3(side === "left" ? 0.3 : -0.3, 0.02, 0.55)),
    target,
    up: new Vector3(0, 1, 0),
  };
}
function Actor({
  timeline,
  transport,
  skeleton,
  focus,
  selectedTargets = [],
  onTick,
  onReady,
}: Omit<Props, "onCanvas">) {
  const character =
    new URLSearchParams(window.location.search).get("character") === "mixamo"
      ? "local-assets/character.glb"
      : "assets/character.glb";
  const gltf = useGLTF(`${import.meta.env.BASE_URL}${character}`);
  const scene = useMemo(() => clone(gltf.scene), [gltf.scene]);
  const rig = useMemo(
    () => new MotionRig(scene, gltf.animations),
    [scene, gltf.animations],
  );
  const helper = useMemo(() => new SkeletonHelper(scene), [scene]);
  const selectionKey = [...new Set(selectedTargets)].sort().join(" ");
  const selection = useMemo(
    () => new JointSelection(rig.joints, selectionKey.split(" ")),
    [rig, selectionKey],
  );
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, gl, scene: world } = useThree();
  const lastTick = useRef(0);
  const focusRef = useRef(focus);
  const cameraReady = useRef(false);
  const transition = useRef<{ from: CameraFrame; elapsed: number } | null>(
    null,
  );
  useEffect(() => {
    onReady();
  }, [onReady]);
  useEffect(
    () => () => {
      helper.dispose();
      rig.props.dispose();
    },
    [helper, rig],
  );
  useEffect(() => () => selection.release(), [selection]);
  useEffect(() => {
    const debug = {
      rig,
      scene,
      snapshot: () => rig.snapshot(),
      selectionSnapshot: () => selection.snapshot(),
      cameraSnapshot: () => ({
        position: camera.position.toArray(),
        target:
          controls.current?.target.toArray() ?? bodyFrame().target.toArray(),
        up: camera.up.toArray(),
        focus,
        transitioning: transition.current !== null,
      }),
      seek: (t: number) => {
        transport.current.time = t;
        transport.current.playing = false;
        rig.apply(
          sampleTimeline(timeline, t),
          sampleContacts(timeline, t),
          timeline.props,
        );
        selection.update();
        transition.current = null;
        if (focus !== "body") {
          const side = focus === "left_hand" ? "left" : "right";
          const frame = motionHandFrame(rig.joints, timeline, side, t);
          camera.position.copy(frame.position);
          camera.up.copy(frame.up);
          camera.lookAt(frame.target);
          controls.current?.target.copy(frame.target);
        }
        gl.render(world, camera);
      },
      timeline,
    };
    if (new URLSearchParams(window.location.search).has("dbg"))
      (window as unknown as { __motion?: unknown }).__motion = debug;
    return () => {
      delete (window as unknown as { __motion?: unknown }).__motion;
    };
  }, [rig, scene, timeline, transport, focus, camera, gl, world, selection]);
  useFrame((_, delta) => {
    const state = transport.current;
    if (state.playing) {
      state.time += delta;
      if (state.time >= state.duration) {
        if (state.loop) state.time %= state.duration;
        else {
          state.time = state.duration;
          state.playing = false;
        }
      }
    }
    rig.apply(
      sampleTimeline(timeline, state.time),
      sampleContacts(timeline, state.time),
      timeline.props,
    );
    selection.update();
    const changedFocus = focusRef.current !== focus;
    focusRef.current = focus;
    if (changedFocus && cameraReady.current) {
      transition.current = {
        from: {
          position: camera.position.clone(),
          target: controls.current?.target.clone() ?? bodyFrame().target,
          up: camera.up.clone(),
        },
        elapsed: 0,
      };
    }
    const side = focus === "left_hand" ? "left" : "right";
    if (transition.current) {
      transition.current.elapsed += Math.min(delta, 0.1);
      const progress = Math.min(transition.current.elapsed / 0.6, 1);
      const destination =
        focus === "body"
          ? bodyFrame()
          : motionHandFrame(rig.joints, timeline, side, state.time);
      const frame = blendFrame(transition.current.from, destination, progress);
      camera.position.copy(frame.position);
      camera.up.copy(frame.up);
      controls.current?.target.copy(frame.target);
      camera.lookAt(frame.target);
      if (progress === 1) transition.current = null;
    } else if (focus !== "body") {
      const frame = motionHandFrame(rig.joints, timeline, side, state.time);
      // Authored orbits already contain smooth timing. Evaluate them directly
      // so seeking or restarting cannot lerp a shortcut through the hand.
      const authoredCamera = timeline.tracks.some(
        (track) => track.target === `${side}_hand_camera`,
      );
      const follow =
        !cameraReady.current || authoredCamera ? 1 : 1 - Math.exp(-12 * delta);
      camera.position.lerp(frame.position, follow);
      camera.up.lerp(frame.up, follow).normalize();
      controls.current?.target.lerp(frame.target, follow);
      camera.lookAt(controls.current?.target ?? frame.target);
    } else controls.current?.update();
    cameraReady.current = true;
    if (controls.current)
      controls.current.enabled = focus === "body" && !transition.current;
    lastTick.current += delta;
    if (lastTick.current > 0.06) {
      lastTick.current = 0;
      onTick(state.time, state.playing);
    }
  });
  return (
    <>
      <primitive object={scene} dispose={null} />
      <primitive object={selection} dispose={null} />
      {skeleton && <primitive object={helper} />}
      <OrbitControls
        ref={controls}
        target={[0, 0.95, 0]}
        enablePan={false}
        minDistance={0.35}
        maxDistance={7}
        maxPolarAngle={Math.PI / 1.95}
        enabled={focus === "body"}
      />
    </>
  );
}
export default function MotionStage(props: Props) {
  const lowQuality =
    new URLSearchParams(window.location.search).get("quality") === "low";
  return (
    <Canvas
      shadows={!lowQuality}
      dpr={lowQuality ? 1 : [1, 1.5]}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      camera={{ position: [2.5, 1.8, 4.5], fov: 30 }}
      onCreated={({ gl }) => props.onCanvas(gl.domElement)}
    >
      <color attach="background" args={["#12121a"]} />
      <fog attach="fog" args={["#12121a", 6, 13]} />
      <hemisphereLight args={["#fff9f2", "#343442", 1.35]} />
      <directionalLight
        position={[3, 6, 4]}
        color="#fff6ea"
        intensity={2.5}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0002}
      />
      <directionalLight
        position={[-3, 3, 1]}
        color="#e7e9ff"
        intensity={1.35}
      />
      <directionalLight position={[0, 3, -4]} color="#e4dcff" intensity={2} />
      {props.focus === "body" && (
        <Grid
          position={[0, -0.014, 0]}
          args={[16, 16]}
          cellSize={0.25}
          sectionSize={1}
          cellColor="#20202a"
          sectionColor="#2d2c39"
          fadeDistance={5}
          fadeStrength={3}
          infiniteGrid
        />
      )}
      {!lowQuality && (
        <ContactShadows
          position={[0, -0.01, 0]}
          opacity={0.45}
          scale={7}
          blur={2.8}
          far={3}
          resolution={512}
        />
      )}
      <Suspense fallback={null}>
        <Actor {...props} />
      </Suspense>
    </Canvas>
  );
}
