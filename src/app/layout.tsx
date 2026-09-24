import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "Airbnb Automation", template: "%s · Airbnb Automation" },
  description:
    "A clear, accountable workspace for short-term rental operations.",
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{document.documentElement.dataset.theme=localStorage.getItem('str-theme')||'dark'}catch{}",
          }}
        />
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
