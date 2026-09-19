const localDevOrigins = [
  "usage.localhost",
  "*.usage.localhost",
  "usage-e2e.localhost",
  "*.usage-e2e.localhost",
  "*.vercel.run",
];

export const getAllowedDevOrigins = (portlessUrl?: string): string[] => {
  if (portlessUrl === undefined) return [...localDevOrigins];

  const url = URL.canParse(portlessUrl) ? new URL(portlessUrl) : null;

  if (
    url === null ||
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname.includes("*") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Invalid PORTLESS_URL for dev origins");
  }

  return [...new Set([...localDevOrigins, url.hostname])];
};
