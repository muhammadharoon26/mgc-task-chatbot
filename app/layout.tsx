import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MGC Sales Copilot",
  description:
    "Grounded document assistant for MGC Aurora Heights — answers cite their source or refuse.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
