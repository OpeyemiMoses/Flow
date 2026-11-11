import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

export function IconDashboard({
  size = 18,
  className = "",
  ...props
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="3" width="7" height="9" rx="2" />
      <rect x="14" y="3" width="7" height="5" rx="2" />
      <rect x="14" y="12" width="7" height="9" rx="2" />
      <rect x="3" y="16" width="7" height="5" rx="2" />
    </svg>
  );
}

export function IconWallet({ size = 18, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" />
      <rect x="15" y="9" width="6" height="6" rx="1.5" />
      <circle cx="18" cy="12" r="0.75" fill="currentColor" />
    </svg>
  );
}

export function IconSend({ size = 18, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M7 17L17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

export function IconReceive({
  size = 18,
  className = "",
  ...props
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M17 7L7 17" />
      <path d="M16 17H7V8" />
    </svg>
  );
}

export function IconSwap({ size = 18, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M16 3l4 4-4 4" />
      <path d="M20 7H4" />
      <path d="M8 21l-4-4 4-4" />
      <path d="M4 17h16" />
    </svg>
  );
}

export function IconActivity({
  size = 18,
  className = "",
  ...props
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function IconUsers({ size = 18, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function IconShield({ size = 18, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function IconSettings({
  size = 18,
  className = "",
  ...props
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function IconBuilding({
  size = 18,
  className = "",
  ...props
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M9 22v-4h6v4" />
      <path d="M8 6h.01" />
      <path d="M16 6h.01" />
      <path d="M12 6h.01" />
      <path d="M12 10h.01" />
      <path d="M12 14h.01" />
      <path d="M16 10h.01" />
      <path d="M16 14h.01" />
      <path d="M8 10h.01" />
      <path d="M8 14h.01" />
    </svg>
  );
}

export function IconRefresh({
  size = 18,
  className = "",
  ...props
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export function IconCopy({ size = 16, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function IconCheck({ size = 16, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function IconSearch({ size = 16, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function IconLock({ size = 16, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function IconSun({ size = 16, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

export function IconMoon({ size = 16, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

export function IconInfo({ size = 16, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

export function IconAlertTriangle({
  size = 16,
  className = "",
  ...props
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function IconExternalLink({
  size = 16,
  className = "",
  ...props
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

export function UsdcIcon({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={`shrink-0 ${className}`}
      aria-label="USD Coin (USDC)"
    >
      <circle cx="16" cy="16" r="16" fill="#2775CA" />
      <circle
        cx="16"
        cy="16"
        r="11.5"
        stroke="#FFFFFF"
        strokeWidth="1.2"
        strokeOpacity="0.45"
        strokeDasharray="2.5 1.5"
      />
      <path
        d="M17.6 13.1c-1.1-.2-1.8-.4-1.8-1 0-.6.6-.9 1.5-.9 1 0 1.7.3 2.1.6l.7-1.3c-.6-.5-1.5-.8-2.5-.9V8h-1.4v1.5c-1.5.2-2.5 1.1-2.5 2.3 0 1.6 1.3 2.2 2.8 2.5 1.2.3 1.6.6 1.6 1.1 0 .6-.6 1-1.6 1-1.1 0-1.9-.4-2.5-.9l-.8 1.3c.7.7 1.7 1.1 2.9 1.2v1.5h1.4v-1.5c1.5-.2 2.6-1.1 2.6-2.5 0-1.8-1.4-2.3-2.8-2.6z"
        fill="#FFFFFF"
      />
      <path
        d="M12.6 10.5c-2.1 1.4-3.4 3.7-3.4 6.3s1.3 4.9 3.4 6.3l.9-1.3c-1.7-1.1-2.7-3-2.7-5s1-3.9 2.7-5l-.9-1.3zm6.8 0l-.9 1.3c1.7 1.1 2.7 3 2.7 5s-1 3.9-2.7 5l.9 1.3c2.1-1.4 3.4-3.7 3.4-6.3s-1.3-4.9-3.4-6.3z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

export function UsdtIcon({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={`shrink-0 ${className}`}
      aria-label="Tether (USDT)"
    >
      <circle cx="16" cy="16" r="16" fill="#26A17B" />
      <path
        d="M17.92 14.73c-.1.01-.58.04-1.92.04-1.07 0-1.74-.03-1.94-.04v-2.07h3.86v2.07zm0-3.08v-.95h4.15V7.47H9.93v3.23h4.13v.95c-3.73.18-6.53.94-6.53 1.86s2.8 1.68 6.53 1.86v6.6h3.86v-6.6c3.72-.18 6.51-.94 6.51-1.86s-2.79-1.68-6.51-1.86zm0 4.09c3.06-.15 5.23-.71 5.23-1.37 0-.66-2.17-1.22-5.23-1.37v1.84c-.32.02-.75.03-1.17.03-.49 0-.89-.01-1.23-.03v-1.84c-3.06.15-5.23.71-5.23 1.37 0 .66 2.17 1.22 5.23 1.37v1.85c.34.02.74.03 1.23.03.42 0 .85-.01 1.17-.03v-1.85z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

export function EthIcon({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={`shrink-0 ${className}`}
      aria-label="Ethereum (ETH)"
    >
      <circle cx="16" cy="16" r="16" fill="#1C1C1C" />
      <g transform="translate(6, 4) scale(0.82)">
        <polygon
          points="12,1 11.7,1.8 11.7,17.2 12,17.5 18.5,13.5"
          fill="#8A92B2"
        />
        <polygon points="12,1 5.5,12 12,17.5 12,9" fill="#FFFFFF" />
        <polygon
          points="12,18.5 11.8,18.8 11.8,25 12,25.4 18.5,16"
          fill="#8A92B2"
        />
        <polygon points="12,25.4 12,18.5 5.5,16" fill="#FFFFFF" />
        <polygon points="12,17.5 18.5,13.5 12,10.2" fill="#62688F" />
        <polygon points="5.5,13.5 12,17.5 12,10.2" fill="#E0E2EC" />
      </g>
    </svg>
  );
}

export function SolIcon({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={`shrink-0 ${className}`}
      aria-label="Solana (SOL)"
    >
      <circle cx="16" cy="16" r="16" fill="#000000" />
      <defs>
        <linearGradient id="sol-icon-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#00FFA3" />
          <stop offset="100%" stopColor="#DC1FFF" />
        </linearGradient>
      </defs>
      <g transform="translate(4, 5.5) scale(0.75)">
        <path
          d="M6.5 21.6c.15-.15.35-.23.56-.23h18.1c.36 0 .54.43.28.69l-2.4 2.4c-.15.15-.35.23-.56.23H4.4c-.36 0-.54-.43-.28-.69l2.4-2.4zm0-13.4c.15-.15.35-.23.56-.23h18.1c.36 0 .54.43.28.69l-2.4 2.4c-.15.15-.35.23-.56.23H4.4c-.36 0-.54-.43-.28-.69l2.4-2.4zm20.8 6.7c-.15-.15-.35-.23-.56-.23H8.7c-.36 0-.54.43-.28.69l2.4 2.4c.15.15.35.23.56.23h18.1c.36 0 .54-.43.28-.69l-2.4-2.4z"
          fill="url(#sol-icon-grad)"
        />
      </g>
    </svg>
  );
}

export function NearIcon({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={`shrink-0 ${className}`}
      aria-label="NEAR Protocol"
    >
      <circle cx="16" cy="16" r="16" fill="#000000" />
      <path
        d="M21.5 8.2c-.4-.3-1-.2-1.3.2L14.7 17c-.2.2-.5.3-.7.3s-.5-.1-.7-.3l-2.6-3.4c-.6-.8-1.7-1-2.5-.4-.8.6-1 1.7-.4 2.5l3.2 4.2c.8 1.1 2.2 1.7 3.6 1.6 1.4-.1 2.7-.9 3.3-2.1L21.7 9.5c.3-.4.2-1-.2-1.3z"
        fill="#FFFFFF"
      />
      <path
        d="M20.8 11.2c-.5-.7-1.5-.9-2.2-.4-.7.5-.9 1.5-.4 2.2l2.6 3.4c.2.2.3.5.2.8-.1.3-.3.5-.6.6-.3.1-.6 0-.8-.2L13.8 9.5c-.7-1-1.9-1.6-3.1-1.5-1.3.1-2.4.9-2.9 2.1l-1.6 4.3c-.3.8.1 1.7.9 2 .8.3 1.7-.1 2-.9l1.4-3.7c.1-.3.4-.5.7-.6.3-.1.6 0 .8.2l7.1 8.5c.6.7 1.4 1.1 2.3 1.1h.4c1-.1 1.9-.7 2.4-1.5l1.6-4.3c.5-1.4.1-3-.9-3.9z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

export function BaseChainIcon({
  size = 24,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={`shrink-0 ${className}`}
      aria-label="Base"
    >
      <circle cx="16" cy="16" r="16" fill="#0052FF" />
      <path
        d="M16 6.5C10.75 6.5 6.5 10.75 6.5 16S10.75 25.5 16 25.5 25.5 21.25 25.5 16 21.25 6.5 16 6.5zm-1.8 13.8c-2.4 0-4.3-1.9-4.3-4.3s1.9-4.3 4.3-4.3c2.3 0 4.1 1.7 4.3 3.9h-2.1c-.2-1.1-1.1-1.9-2.2-1.9-1.2 0-2.2 1-2.2 2.3s1 2.3 2.2 2.3c1.1 0 2-.8 2.2-1.9h2.1c-.2 2.2-2 3.9-4.3 3.9z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

export const COINGECKO_ASSET_IMAGES: Record<
  string,
  { src: string; coingeckoUrl: string; alt: string; bg?: string }
> = {
  USDC: {
    src: "/assets/tokens/usdc.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/coins/images/6319/large/USDC.png",
    alt: "USD Coin (USDC)",
  },
  USDT: {
    src: "/assets/tokens/usdt.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/coins/images/325/large/Tether.png",
    alt: "Tether (USDT)",
  },
  ETH: {
    src: "/assets/tokens/eth.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/coins/images/279/large/ethereum.png",
    alt: "Ethereum (ETH)",
    bg: "bg-neutral-900",
  },
  WETH: {
    src: "/assets/tokens/eth.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/coins/images/279/large/ethereum.png",
    alt: "Wrapped Ether (WETH)",
    bg: "bg-neutral-900",
  },
  CBETH: {
    src: "/assets/tokens/eth.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/coins/images/279/large/ethereum.png",
    alt: "Coinbase Wrapped Staked ETH (cbETH)",
    bg: "bg-neutral-900",
  },
  SOL: {
    src: "/assets/tokens/sol.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/coins/images/4128/large/solana.png",
    alt: "Solana (SOL)",
    bg: "bg-black",
  },
  MSOL: {
    src: "/assets/tokens/sol.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/coins/images/4128/large/solana.png",
    alt: "Marinade staked SOL (mSOL)",
    bg: "bg-black",
  },
  NEAR: {
    src: "/assets/tokens/near.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/coins/images/10365/large/near.jpg",
    alt: "NEAR Protocol (NEAR)",
  },
  WNEAR: {
    src: "/assets/tokens/near.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/coins/images/10365/large/near.jpg",
    alt: "Wrapped NEAR (wNEAR)",
  },
};

export const COINGECKO_CHAIN_IMAGES: Record<
  string,
  { src: string; coingeckoUrl: string; alt: string; bg?: string }
> = {
  ethereum: {
    src: "/assets/tokens/eth.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/asset_platforms/images/279/large/ethereum.png",
    alt: "Ethereum Mainnet",
    bg: "bg-neutral-900",
  },
  base: {
    src: "/assets/tokens/base.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/asset_platforms/images/131/large/base.png",
    alt: "Base Mainnet",
  },
  solana: {
    src: "/assets/tokens/sol.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/asset_platforms/images/5/large/solana.png",
    alt: "Solana Mainnet",
    bg: "bg-black",
  },
  near: {
    src: "/assets/tokens/near.png",
    coingeckoUrl:
      "https://coin-images.coingecko.com/asset_platforms/images/34/large/near.jpeg",
    alt: "NEAR Mainnet",
  },
};

export function ChainBadge({
  chainKey,
  size = 24,
  className = "",
}: {
  chainKey: string;
  size?: number;
  className?: string;
}) {
  const lower = chainKey.toLowerCase();
  let matchKey: string | null = null;
  if (lower.includes("base")) matchKey = "base";
  else if (lower.includes("sol")) matchKey = "solana";
  else if (lower.includes("near")) matchKey = "near";
  else if (lower.includes("eth") || lower.includes("evm"))
    matchKey = "ethereum";

  const chain = matchKey ? COINGECKO_CHAIN_IMAGES[matchKey] : undefined;
  if (chain) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded-full overflow-hidden shrink-0 select-none shadow-2xs ${chain.bg ?? "bg-white"} ${className}`}
        style={{ width: size, height: size }}
      >
        <img
          src={chain.src}
          alt={chain.alt}
          width={size}
          height={size}
          className="h-full w-full object-cover"
          onError={(e) => {
            if (e.currentTarget.src !== chain.coingeckoUrl) {
              e.currentTarget.src = chain.coingeckoUrl;
            }
          }}
        />
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full bg-slate-200 text-slate-700 font-bold select-none shrink-0 ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
    >
      •
    </span>
  );
}

export function IconChevronDown({
  size = 16,
  className = "",
  ...props
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function IconQrCode({ size = 18, className = "", ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3z" />
      <path d="M20 14v3h-3" />
      <path d="M14 20h6" />
    </svg>
  );
}

export function AssetAvatar({
  symbol,
  size = 32,
  className = "",
}: {
  symbol: string;
  size?: number;
  className?: string;
}) {
  const upper = symbol.toUpperCase();
  const token = COINGECKO_ASSET_IMAGES[upper];

  if (token) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded-full overflow-hidden shrink-0 select-none shadow-2xs ${token.bg ?? "bg-transparent"} ${className}`}
        style={{ width: size, height: size }}
      >
        <img
          src={token.src}
          alt={token.alt}
          width={size}
          height={size}
          className={`h-full w-full ${token.bg ? "object-contain p-1" : "object-cover"}`}
          onError={(e) => {
            if (e.currentTarget.src !== token.coingeckoUrl) {
              e.currentTarget.src = token.coingeckoUrl;
            }
          }}
        />
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 font-display font-bold select-none shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.34)),
      }}
    >
      {upper.slice(0, 4)}
    </span>
  );
}
