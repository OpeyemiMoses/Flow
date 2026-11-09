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
  const isWhite = variant === "inverse" || variant === "mono-white";
  const src = isWhite
    ? "/assets/flow-symbol-white.png"
    : "/assets/flow-symbol.png";

  return (
    <img
      src={src}
      alt="FLOW"
      width={size}
      height={size}
      style={{ width: `${size}px`, height: `${size}px` }}
      className={`inline-block object-contain select-none ${className}`}
      aria-hidden="true"
    />
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
  const isWhite = variant === "inverse" || variant === "mono-white";

  if (markOnly) {
    return <FlowMark size={size} variant={variant} className={className} />;
  }

  const logoSrc = isWhite
    ? "/assets/flow-logo-white.png"
    : "/assets/flow-logo.png";

  return (
    <span
      className={`inline-flex items-center gap-2.5 select-none ${className}`}
    >
      <span className="flex flex-col leading-none">
        <img
          src={logoSrc}
          alt="FLOW"
          height={size}
          style={{ height: `${size}px`, width: "auto" }}
          className="object-contain"
        />
        {subtitle && (
          <span
            className={`mt-0.5 text-[10px] font-medium tracking-wider uppercase ${
              isWhite ? "text-neutral-400" : "text-neutral-500"
            }`}
          >
            {subtitle}
          </span>
        )}
      </span>
    </span>
  );
}

export function FlowWaveGraphic({ className = "" }: { className?: string }) {
  return (
    <div
      className={`pointer-events-none select-none overflow-hidden ${className}`}
      aria-hidden="true"
    >
      <div className="h-full w-full bg-[radial-gradient(ellipse_at_center,_rgba(255,26,26,0.18)_0%,_rgba(255,26,26,0.04)_40%,_transparent_75%)]" />
    </div>
  );
}
