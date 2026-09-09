import { useEffect, useId, useRef, useState } from "react";
import {
  BookOpen,
  Bot,
  Drama,
  Gamepad2,
  Github,
  Globe,
  Languages,
  Menu,
  Package,
  Play,
  ShieldCheck,
  X,
} from "lucide-react";
import "./site-header.css";

const SITE = "https://programasweights.com";
const SIGN_IN = `${SITE}/api/v1/auth/github?return_to=${encodeURIComponent("/avatar")}`;
const NAVIGATION = [
  { path: "/playground", label: "Playground", icon: Play },
  { path: "/hub", label: "Hub", icon: Package },
  {
    path: "/browser",
    label: "Run in Browser",
    desktopLabel: "Browser",
    icon: Globe,
  },
  { path: "/docs", label: "Docs", icon: BookOpen },
  { path: "/agents", label: "Agents", icon: Bot },
  { path: "/claudish", label: "Claudish", icon: Languages },
  { path: "/pii", label: "PII Masker", desktopLabel: "PII", icon: ShieldCheck },
  { path: "/avatar", label: "Avatar", icon: Drama },
  { path: "/alien", label: "Game", icon: Gamepad2 },
];

function PawLogo() {
  return (
    <svg viewBox="0 0 789 717" aria-hidden="true" focusable="false">
      <g transform="translate(0 717) scale(0.1 -0.1)" fill="currentColor">
        <path d="M4840 6554 c-311 -67 -584 -429 -692 -919 -30 -136 -33 -455 -5 -585 80 -375 261 -625 532 -735 91 -37 253 -46 354 -20 301 78 543 369 656 789 74 276 71 562 -10 842 -81 276 -244 496 -437 587 -111 53 -270 69 -398 41z" />
        <path d="M2789 6545 c-169 -43 -330 -160 -425 -309 -85 -135 -156 -331 -185 -506 -21 -129 -18 -452 5 -560 34 -157 67 -254 130 -385 131 -268 277 -412 491 -482 67 -22 99 -26 200 -27 136 -1 187 10 289 62 79 41 208 158 260 236 194 292 260 700 176 1088 -90 414 -344 775 -611 868 -83 28 -249 36 -330 15z" />
        <path d="M6486 5264 c-239 -58 -491 -297 -641 -609 -162 -336 -179 -759 -43 -1045 54 -112 187 -250 291 -299 91 -44 214 -60 330 -43 243 35 524 286 666 593 99 215 141 398 141 611 0 213 -32 354 -113 497 -131 232 -390 353 -631 295z" />
        <path d="M1140 5254 c-107 -28 -173 -69 -259 -160 -164 -173 -232 -393 -217 -699 12 -256 98 -526 227 -717 54 -79 186 -216 272 -282 123 -94 241 -136 384 -136 178 0 261 36 393 169 112 112 167 206 202 347 20 77 23 115 23 284 0 218 -16 319 -80 497 -122 340 -394 628 -660 699 -65 18 -215 17 -285 -2z" />
        <path d="M3850 4133 c-195 -19 -396 -86 -555 -183 -166 -102 -266 -194 -453 -418 -221 -266 -334 -370 -524 -481 -46 -26 -127 -74 -180 -105 -54 -31 -133 -84 -176 -116 -224 -168 -400 -446 -459 -720 -25 -118 -25 -391 0 -508 35 -163 108 -331 209 -484 147 -221 391 -398 638 -462 158 -41 237 -51 400 -50 186 1 276 19 590 119 380 122 507 144 711 125 147 -14 240 -36 481 -115 443 -146 664 -164 988 -78 186 49 357 151 516 308 328 323 449 855 297 1305 -106 316 -335 559 -708 756 -60 31 -144 80 -185 108 -99 67 -279 247 -427 426 -148 179 -255 281 -390 370 -168 111 -334 171 -543 195 -121 15 -156 16 -230 8z" />
      </g>
    </svg>
  );
}

export default function SiteHeader() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        toggle.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!header.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const navigation = (mobile = false) =>
    NAVIGATION.map(({ path, label, desktopLabel, icon: Icon }) => (
      <a
        key={path}
        href={`${SITE}${path}`}
        aria-current={path === "/avatar" ? "page" : undefined}
        className="paw-site-header__nav-link"
        onClick={() => setOpen(false)}
      >
        <Icon size={16} aria-hidden="true" />
        <span>{mobile ? label : (desktopLabel ?? label)}</span>
      </a>
    ));

  return (
    <header className="paw-site-header" ref={header}>
      <div className="paw-site-header__container">
        <div className="paw-site-header__row">
          <a
            href={SITE}
            className="paw-site-header__brand"
            aria-label="PAW — ProgramAsWeights home"
          >
            <span className="paw-site-header__logo">
              <PawLogo />
            </span>
            <span className="paw-site-header__wordmark">
              <span>PAW</span>
              <small>ProgramAsWeights</small>
            </span>
          </a>
          <nav
            className="paw-site-header__desktop-nav"
            aria-label="Main navigation"
          >
            {navigation()}
          </nav>
          <div className="paw-site-header__actions">
            <a
              href="https://github.com/programasweights/programasweights-python"
              target="_blank"
              rel="noopener noreferrer"
              className="paw-site-header__github"
              aria-label="ProgramAsWeights on GitHub"
            >
              <Github size={16} aria-hidden="true" />
              <span>GitHub</span>
            </a>
            <a href={SIGN_IN} className="paw-site-header__sign-in">
              <Github size={16} aria-hidden="true" />
              <span>Sign in</span>
            </a>
            <button
              ref={toggle}
              type="button"
              className="paw-site-header__toggle"
              aria-expanded={open}
              aria-controls={menuId}
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? (
                <X size={20} aria-hidden="true" />
              ) : (
                <Menu size={20} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
        {open && (
          <nav
            id={menuId}
            className="paw-site-header__mobile-nav"
            aria-label="Mobile navigation"
          >
            {navigation(true)}
            <a href={SIGN_IN} className="paw-site-header__mobile-sign-in">
              <Github size={20} aria-hidden="true" />
              <span>Sign in with GitHub</span>
            </a>
          </nav>
        )}
      </div>
    </header>
  );
}
