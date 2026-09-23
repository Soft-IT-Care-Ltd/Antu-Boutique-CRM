import bcrypt from "bcryptjs";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";

import { refreshSessionToken } from "@/lib/auth/session-refresh";
import { prisma } from "@/lib/prisma";

const LOCKOUT_MINUTES = 15;
const MAX_FAILED_ATTEMPTS = 5;

const credentialsSchema = z.object({
  identifier: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(255),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        identifier: { label: "Phone or email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;
        const { identifier, password } = parsed.data;

        const user = await prisma.user.findFirst({
          where: {
            isActive: true,
            OR: [{ phone: identifier }, { email: identifier }],
          },
          include: { role: true },
        });
        if (!user) return null;

        if (user.lockedUntil && user.lockedUntil > new Date()) return null;

        const valid = await bcrypt.compare(password, user.passwordHash);

        if (!valid) {
          const failedLoginCount = user.failedLoginCount + 1;
          const lockedOut = failedLoginCount >= MAX_FAILED_ATTEMPTS;
          await prisma.user.update({
            where: { id: user.id },
            data: {
              failedLoginCount: lockedOut ? 0 : failedLoginCount,
              lockedUntil: lockedOut
                ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
                : user.lockedUntil,
            },
          });
          return null;
        }

        await prisma.user.update({
          where: { id: user.id },
          data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
        });

        return {
          id: user.id,
          name: user.name,
          email: user.email ?? undefined,
          role: user.role.name,
          teamId: user.teamId,
          mustChangePassword: user.mustChangePassword,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // Sign-in: `authorize` just read this user from the DB.
      if (user) {
        token.id = user.id as string;
        token.role = user.role;
        token.teamId = user.teamId;
        token.mustChangePassword = user.mustChangePassword;
        return token;
      }

      // Every later request (proxy, pages, API routes, the uploads route)
      // re-checks the user: deleted/deactivated → null signs them out on
      // this request; a role/team/password-flag change applies right away.
      // This also covers the change-password flow's `update()` call.
      return refreshSessionToken(prisma, token);
    },
    async session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      session.user.teamId = token.teamId;
      session.user.mustChangePassword = token.mustChangePassword;
      return session;
    },
  },
});
