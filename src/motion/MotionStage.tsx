import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  ContactShadows,
  Grid,
  OrbitControls,
  useGLTF,
} from "@react-three/drei";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { SkeletonHelper, Vector3 } from "three";
import type { Bone } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Timeline } from "./types";
import { sampleContacts, sampleTimeline } from "./engine";
import { MotionRig } from "./rig";
import { frameHand, frameHandOrbit } from "./handCamera";

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
  onTick: (time: number, playing: boolean) => void;
  onReady: () => void;
  onCanvas: (canvas: HTMLCanvasElement) => void;
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
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, gl, scene: world } = useThree();
  const lastTick = useRef(0);
  const focusRef = useRef(focus);
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
  useEffect(() => {
    const debug = {
      rig,
      scene,
      snapshot: () => rig.snapshot(),
      seek: (t: number) => {
        transport.current.time = t;
        transport.current.playing = false;
        rig.apply(
          sampleTimeline(timeline, t),
          sampleContacts(timeline, t),
          timeline.props,
        );
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
  }, [rig, scene, timeline, transport, focus, camera, gl, world]);
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
    const changedFocus = focusRef.current !== focus;
    focusRef.current = focus;
    if (changedFocus && focus === "body") {
      camera.up.set(0, 1, 0);
      camera.position.set(2.5, 1.8, 4.5);
      controls.current?.target.set(0, 0.95, 0);
    }
    if (focus !== "body") {
      const side = focus === "left_hand" ? "left" : "right";
      const frame = motionHandFrame(rig.joints, timeline, side, state.time);
      // Authored orbits already contain smooth timing. Evaluate them directly
      // so seeking or restarting cannot lerp a shortcut through the hand.
      const authoredCamera = timeline.tracks.some(
        (track) => track.target === `${side}_hand_camera`,
      );
      const follow =
        changedFocus || authoredCamera ? 1 : 1 - Math.exp(-12 * delta);
      camera.position.lerp(frame.position, follow);
      camera.up.lerp(frame.up, follow).normalize();
      controls.current?.target.lerp(frame.target, follow);
      camera.lookAt(controls.current?.target ?? frame.target);
    } else controls.current?.update();
    lastTick.current += delta;
    if (lastTick.current > 0.06) {
      lastTick.current = 0;
      onTick(state.time, state.playing);
    }
  });
  return (
    <>
      <primitive object={scene} dispose={null} />
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
      <color attach="background" args={["#101719"]} />
      <fog attach="fog" args={["#101719", 6, 13]} />
      <hemisphereLight args={["#e7fff7", "#2c3c44", 1.1]} />
      <directionalLight
        position={[3, 6, 4]}
        intensity={3}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0002}
      />
      <directionalLight position={[-3, 3, 1]} color="#8bf6ce" intensity={2} />
      <directionalLight position={[0, 3, -4]} color="#a1b9ff" intensity={3} />
      <Grid
        position={[0, -0.014, 0]}
        args={[16, 16]}
        cellSize={0.25}
        sectionSize={1}
        cellColor="#283c3d"
        sectionColor="#405553"
        fadeDistance={8}
        fadeStrength={2}
        infiniteGrid
      />
      {!lowQuality && (
        <ContactShadows
          position={[0, -0.01, 0]}
          opacity={0.6}
          scale={7}
          blur={2.2}
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
