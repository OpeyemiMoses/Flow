"use client";

import { useEffect, useState } from "react";

const DEFAULT_AVATAR_SRC = "/assets/amara-avatar.png";

export function getUserAvatar(): string {
  if (typeof window === "undefined") return DEFAULT_AVATAR_SRC;
  try {
    return window.localStorage.getItem("flow-user-avatar") || DEFAULT_AVATAR_SRC;
  } catch {
    return DEFAULT_AVATAR_SRC;
  }
}

export function setUserAvatar(dataUrl: string): void {
  try {
    window.localStorage.setItem("flow-user-avatar", dataUrl);
    window.dispatchEvent(new Event("flow-avatar-change"));
  } catch (err) {
    console.error("Failed to persist avatar:", err);
  }
}

export function resetUserAvatar(): void {
  try {
    window.localStorage.removeItem("flow-user-avatar");
    window.dispatchEvent(new Event("flow-avatar-change"));
  } catch {
    // ignore
  }
}

export function UserAvatar({
  className = "h-9 w-9 rounded-full object-cover border border-white/20 shrink-0",
  alt = "Profile",
  defaultSrc = DEFAULT_AVATAR_SRC,
  size,
}: {
  className?: string;
  alt?: string;
  defaultSrc?: string;
  size?: number;
}) {
  const [src, setSrc] = useState(defaultSrc);

  useEffect(() => {
    const sync = () => {
      try {
        const stored = window.localStorage.getItem("flow-user-avatar");
        setSrc(stored || defaultSrc);
      } catch {
        setSrc(defaultSrc);
      }
    };
    sync();
    window.addEventListener("flow-avatar-change", sync);
    return () => window.removeEventListener("flow-avatar-change", sync);
  }, [defaultSrc]);

  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      style={size ? { width: `${size}px`, height: `${size}px` } : undefined}
      className={className}
      onError={() => setSrc(defaultSrc)}
    />
  );
}
