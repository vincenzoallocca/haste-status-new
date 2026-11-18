import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateCredentials, createSession, userToPublic } from '$lib/server/db/auth';
import { clearLoginFailures, isLoginRateLimited, recordLoginFailure } from '$lib/server/db/login-limit';

export const POST: RequestHandler = async ({ request, cookies, platform, getClientAddress }) => {
	if (!platform?.env?.DB) {
		return json({ error: 'Database not available' }, { status: 500 });
	}

	const db = platform.env.DB;

	let input: { email: string; password: string };
	try {
		input = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	if (!input.email || !input.password) {
		return json({ error: 'Email and password are required' }, { status: 400 });
	}

	let ip = '';
	try {
		ip = request.headers.get('CF-Connecting-IP') ?? getClientAddress();
	} catch {
		ip = '';
	}

	try {
		if (await isLoginRateLimited(db, input.email, ip)) {
			return json(
				{ error: 'Too many failed attempts. Try again in a few minutes.' },
				{ status: 429, headers: { 'Retry-After': '900' } }
			);
		}

		const user = await validateCredentials(db, input.email, input.password);

		if (!user) {
			await recordLoginFailure(db, input.email, ip);
			return json({ error: 'Invalid email or password' }, { status: 401 });
		}
		await clearLoginFailures(db, input.email);

		// Create session
		const session = await createSession(db, user.id);

		// Set cookie
		cookies.set('session', session.id, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			maxAge: 60 * 60 * 24 * 7 // 7 days
		});

		return json({ success: true, user: userToPublic(user) });
	} catch (err) {
		console.error('Login error:', err);
		return json({ error: 'Login failed' }, { status: 500 });
	}
};
