// netlify/edge-functions/auth-gate.mjs
//
// Puts the whole site behind a simple username/password prompt (HTTP
// Basic Auth), so the dashboard isn't publicly visible even though the
// site itself is hosted at a public URL. Works on Netlify's free plan.
//
// Required environment variables (set in Netlify site settings):
//   SITE_USERNAME
//   SITE_PASSWORD

export default async (request, context) => {
  const expectedUser = Netlify.env.get("SITE_USERNAME");
  const expectedPass = Netlify.env.get("SITE_PASSWORD");

  if (!expectedUser || !expectedPass) {
    // Fail closed: if credentials aren't configured, block access rather
    // than accidentally serving the dashboard publicly.
    return new Response("Site not yet configured. Set SITE_USERNAME and SITE_PASSWORD.", {
      status: 503,
    });
  }

  const authHeader = request.headers.get("authorization");

  if (authHeader && authHeader.startsWith("Basic ")) {
    const decoded = atob(authHeader.slice(6));
    const separatorIndex = decoded.indexOf(":");
    const user = decoded.slice(0, separatorIndex);
    const pass = decoded.slice(separatorIndex + 1);

    if (user === expectedUser && pass === expectedPass) {
      return context.next();
    }
  }

  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Steps & sleep dashboard"',
    },
  });
};

export const config = {
  path: "/*",
};
