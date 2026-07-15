import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  providers: [
    GitHub({
      clientId: env.AUTH_GITHUB_ID,
      clientSecret: env.AUTH_GITHUB_SECRET,
    }),
  ],
  secret: env.AUTH_SECRET,
  // We explicitly use JWT so our edge middleware can instantly read the 
  // user's role and organization without doing a database lookup on every request.
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, user }) {
      // 'user' is only passed in the very first time they log in
      if (user) {
        token.userId = user.id!;
        
        // Fetch the user's primary/first organization membership on original login
        const defaultMembership = await db.membership.findFirst({
          where: { userId: user.id },
          select: { orgId: true, role: true },
        });

        if (defaultMembership) {
          token.activeOrgId = defaultMembership.orgId;
          token.role = defaultMembership.role;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        session.user.id = token.userId as string;
        session.user.activeOrgId = token.activeOrgId as string;
        // The type cast here aligns with the next-auth.d.ts declaration
        session.user.role = token.role as Role; 
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
});