import { useId } from "react";

export type FlowLogoVariant =
  "primary" | "inverse" | "mono-black" | "mono-white";

export function FlowMark({
  size = 32,
  variant = "primary",
  className = "",
}: {
  size?: number;
  variant?: FlowLogoVariant;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const topGradId = `flow-top-${uid}`;
  const bottomGradId = `flow-bottom-${uid}`;
  const isMonoBlack = variant === "mono-black";
  const isMonoWhite = variant === "mono-white";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {!isMonoBlack && !isMonoWhite && (
        <defs>
          <linearGradient
            id={topGradId}
            x1="6"
            y1="22"
            x2="42"
            y2="8"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#1D4ED8" />
            <stop offset="55%" stopColor="#2563FF" />
            <stop offset="100%" stopColor="#4EA8FF" />
          </linearGradient>
          <linearGradient
            id={bottomGradId}
            x1="8"
            y1="42"
            x2="38"
            y2="18"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#34D8B2" />
            <stop offset="52%" stopColor="#22A8D8" />
            <stop offset="100%" stopColor="#2563FF" />
          </linearGradient>
        </defs>
      )}
      {/* Top flowing ribbon of the F mark */}
      <path
        d="M9 21.5C9 14.5 14.2 9.5 22.5 9.5H41C39.2 15.2 34.4 18.5 26.8 18.5H18.2C14.1 18.5 11.2 20.4 9 24V21.5Z"
        fill={
          isMonoBlack
            ? "#0B1F4B"
            : isMonoWhite
              ? "#FFFFFF"
              : `url(#${topGradId})`
        }
      />
      {/* Lower stem + middle flowing ribbon of the F mark */}
      <path
        d="M9 39.5V27.8C10.8 23.8 14.8 21.5 20.6 21.5H34.5C32.7 26.9 28.2 29.8 21.4 29.8H17.8V35.2C17.8 38.4 15.1 40.5 11.2 40.5H9V39.5Z"
        fill={
          isMonoBlack
            ? "#0B1F4B"
            : isMonoWhite
              ? "#FFFFFF"
              : `url(#${bottomGradId})`
        }
      />
    </svg>
  );
}

export function FlowLogo({
  size = 32,
  variant = "primary",
  markOnly = false,
  subtitle,
  className = "",
}: {
  size?: number;
  variant?: FlowLogoVariant;
  markOnly?: boolean;
  subtitle?: string;
  className?: string;
}) {
  const textColor =
    variant === "inverse" || variant === "mono-white"
      ? "text-white"
      : "text-[#0B1F4B] dark:text-white";

  return (
    <span
      className={`inline-flex items-center gap-2.5 select-none ${className}`}
    >
      <FlowMark size={size} variant={variant} />
      {!markOnly && (
        <span className="flex flex-col leading-none">
          <span
            className={`font-display font-extrabold tracking-[-0.03em] ${textColor}`}
            style={{ fontSize: Math.round(size * 0.72) }}
          >
            FLOW
          </span>
          {subtitle && (
            <span
              className={`mt-0.5 text-[10px] font-medium tracking-wider uppercase ${
                variant === "inverse" || variant === "mono-white"
                  ? "text-slate-300"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              {subtitle}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export function FlowWaveGraphic({ className = "" }: { className?: string }) {
  const uid = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 640 220"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`pointer-events-none select-none ${className}`}
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient
          id={`wave-mint-${uid}`}
          x1="0"
          y1="190"
          x2="640"
          y2="40"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#2563FF" stopOpacity="0.18" />
          <stop offset="50%" stopColor="#34D8B2" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#67F3D0" stopOpacity="0.82" />
        </linearGradient>
        <linearGradient
          id={`wave-blue-${uid}`}
          x1="40"
          y1="210"
          x2="620"
          y2="20"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#0B1F4B" stopOpacity="0.1" />
          <stop offset="45%" stopColor="#2563FF" stopOpacity="0.65" />
          <stop offset="100%" stopColor="#34D8B2" stopOpacity="0.45" />
        </linearGradient>
      </defs>
      <path
        d="M-40 195C95 190 180 120 310 130C440 140 520 55 680 35L680 230L-40 230Z"
        fill={`url(#wave-blue-${uid})`}
      />
      <path
        d="M-20 210C130 165 235 88 370 112C490 133 560 48 670 18"
        stroke={`url(#wave-mint-${uid})`}
        strokeWidth="6"
        strokeLinecap="round"
      />
      <path
        d="M10 222C165 182 260 118 395 136C510 152 575 78 675 46"
        stroke="#34D8B2"
        strokeOpacity="0.35"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
