import type { Metadata } from "next";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: "Sentinel",
  description: "Autonomous incident response, gated behind human approval.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full bg-zinc-950 text-zinc-50 antialiased">
      <body className="h-full">
        {children}
      </body>
    </html>
  );
}