import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Subscription Usage",
  description: "Read-only subscription quota overview for Box",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0f0f11",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
