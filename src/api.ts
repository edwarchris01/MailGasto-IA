import {
  Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Inject,
  Param, Patch, Post, Query, Req, Res, UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Accounts, input, loginInput, normalizedEmail, registerInput, sessionHash, tokenInput, uuid } from './accounts.js';
import { CONFIG, Config, equalSecret } from './config.js';
import { Database } from './db.js';
import { Gmail } from './gmail.js';
import { analyticsInput, Finance, manualInput, movementFilters } from './finance.js';
import { GoogleSignin } from './google-signin.js';
import { gmailResult, GmailResults } from './gmail-results.js';
import { chatInput, filtersSchema, History, historySchema } from './history.js';

const googleCallbackInput = z.object({
  code: z.string().min(1).max(4096).optional(), state: tokenInput.shape.token,
});

@Controller('v1')
export class Api {
  constructor(
    @Inject(Accounts) private readonly accounts: Accounts, @Inject(Gmail) private readonly gmail: Gmail,
    @Inject(History) private readonly history: History, @Inject(Database) private readonly db: Database,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(GmailResults) private readonly gmailResults: GmailResults,
    @Inject(Finance) private readonly finance: Finance,
    @Inject(GoogleSignin) private readonly google: GoogleSignin,
  ) {}

  @Get('health')
  async health() {
    await this.db.query('SELECT 1');
    return { status: 'ok' };
  }

  @Post('auth/register')
  @HttpCode(202)
  async register(@Req() req: Request, @Body() body: unknown) {
    const values = input(registerInput, body);
    await this.accounts.throttle('register:' + req.ip, 12, 3600);
    await this.accounts.register(values);
    return { message: 'Si el correo se puede registrar, recibirás un enlace de verificación.' };
  }

  @Post('auth/verify')
  @HttpCode(204)
  async verify(@Req() req: Request, @Body() body: unknown) {
    await this.accounts.throttle('verify:' + req.ip, 30, 600);
    const values = input(tokenInput.extend({ password: registerInput.shape.password }), body);
    await this.accounts.verify(values.token, values.password);
  }

  @Post('auth/login')
  @HttpCode(200)
  async login(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const values = input(loginInput, body);
    await this.accounts.throttle('login-ip:' + req.ip, 60, 900);
    await this.accounts.throttle('login-email:' + values.email, 12, 900);
    return this.accounts.login(values, res);
  }

  @Post('auth/logout')
  @HttpCode(204)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.accounts.logout(req, res);
  }

  @Get('auth/me')
  me(@Req() req: Request) {
    return this.accounts.current(req);
  }

  @Post('auth/password/reset')
  @HttpCode(202)
  async resetRequest(@Req() req: Request, @Body() body: unknown) {
    const { email } = input(z.object({ email: normalizedEmail }), body);
    await this.accounts.throttle('reset-ip:' + req.ip, 25, 3600);
    await this.accounts.throttle('reset-email:' + email, 6, 3600);
    await this.accounts.requestReset(email);
    return { message: 'Si el correo está asociado a una cuenta, recibirás un enlace.' };
  }

  @Post('auth/password/reset/confirm')
  @HttpCode(204)
  async resetPassword(@Req() req: Request, @Body() body: unknown) {
    await this.accounts.throttle('reset-confirm:' + req.ip, 30, 600);
    const values = input(tokenInput.extend({ password: registerInput.shape.password }), body);
    await this.accounts.resetPassword(values.token, values.password);
  }

  @Patch('account/profile')
  async profile(@Req() req: Request, @Body() body: unknown) {
    const account = await this.accounts.current(req);
    const { name } = input(registerInput.pick({ name: true }), body);
    return this.accounts.rename(account.id, name);
  }

  @Post('account/password')
  @HttpCode(204)
  async password(@Req() req: Request, @Body() body: unknown) {
    const account = await this.accounts.current(req);
    await this.accounts.throttle('change-password:' + account.id, 10, 900);
    const values = input(z.object({
      current: registerInput.shape.password, password: registerInput.shape.password,
    }), body);
    await this.accounts.changePassword(account.id, sessionHash(req), values.current, values.password);
  }

  @Post('mobile/auth/google/authorize')
  @HttpCode(200)
  async googleAuthorize(@Req() req: Request, @Body() body: unknown) {
    const { challenge } = input(z.object({ challenge: tokenInput.shape.token }), body);
    await this.accounts.throttle('google-auth:' + req.ip, 40, 600);
    return { url: await this.google.authorize(challenge) };
  }

  @Get('mobile/auth/google/callback')
  async googleCallback(@Query() query: unknown, @Res() res: Response) {
    return this.returnFromGoogle(query, res, '/mobile/auth/google/return',
      (state, code) => this.google.receive(state, code));
  }

  @Post('mobile/auth/google/complete')
  @HttpCode(200)
  async googleComplete(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    await this.accounts.throttle('google-complete:' + req.ip, 40, 600);
    const { receipt, verifier } = input(z.object({
      receipt: tokenInput.shape.token, verifier: tokenInput.shape.token,
    }), body);
    return this.google.complete(receipt, verifier, res);
  }

  @Post('account/deletion')
  @HttpCode(202)
  async requestDeletion(@Req() req: Request) {
    const owner = await this.accounts.current(req);
    await this.accounts.throttle('delete:' + owner.id, 5, 3600);
    await this.accounts.requestDeletion(owner.id);
    return { message: 'Revisa tu correo verificado para confirmar la eliminación.' };
  }

  @Post('account/deletion/confirm')
  @HttpCode(204)
  async confirmDeletion(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const owner = await this.accounts.current(req);
    await this.accounts.confirmDeletion(owner.id, input(tokenInput, body).token);
    await this.accounts.logout(req, res);
  }

  @Get('mailboxes')
  async listMailboxes(@Req() req: Request) {
    return this.gmail.list((await this.accounts.current(req)).id);
  }

  @Post('mailboxes/gmail/existing')
  async existing(@Req() req: Request) {
    const owner = await this.accounts.current(req);
    return this.gmail.connectLegacy(owner.id, owner.email);
  }

  @Post('mailboxes/gmail/authorize')
  @HttpCode(200)
  async authorize(@Req() req: Request, @Body() body: unknown) {
    const owner = await this.accounts.current(req);
    await this.accounts.throttle('oauth:' + owner.id, 15, 600);
    const { mailboxId } = input(z.object({ mailboxId: uuid.optional() }), body);
    return { url: await this.gmail.authorize(owner.id, sessionHash(req), mailboxId) };
  }

  @Get('mailboxes/gmail/callback')
  async callback(@Req() req: Request, @Query() query: unknown, @Res() res: Response) {
    const owner = await this.accounts.current(req);
    const params = input(z.object({ code: z.string().min(1).max(4096).optional(), state: tokenInput.shape.token.optional() }), query);
    if (!params.code || !params.state) return res.redirect(303, '/#gmail=cancelled');
    await this.gmail.callback(owner.id, sessionHash(req), params.state, params.code);
    return res.redirect(303, '/#gmail=linked');
  }

  @Post('mobile/mailboxes/gmail/authorize')
  @HttpCode(200)
  async authorizeMobile(@Req() req: Request, @Body() body: unknown) {
    const owner = await this.accounts.current(req);
    await this.accounts.throttle('oauth:' + owner.id, 15, 600);
    const { mailboxId } = input(z.object({ mailboxId: uuid.optional() }), body);
    return { url: await this.gmail.authorize(owner.id, sessionHash(req), mailboxId, true) };
  }

  @Get('mobile/mailboxes/gmail/callback')
  async mobileCallback(@Query() query: unknown, @Res() res: Response) {
    return this.returnFromGoogle(query, res, '/mobile/gmail/return',
      (state, code) => this.gmail.mobileCallback(state, code));
  }

  private async returnFromGoogle(
    query: unknown,
    res: Response,
    path: '/mobile/auth/google/return' | '/mobile/gmail/return',
    receive: (state: string, code?: string) => Promise<string | null>,
  ) {
    let fragment = 'status=failed';
    try {
      const { state, code } = input(googleCallbackInput, query);
      const receipt = await receive(state, code);
      fragment = receipt ? 'receipt=' + receipt : 'status=cancelled';
    } catch {
      // Show the failure in the app without exposing the provider response.
    }
    return res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' })
      .location(this.config.origin + path + '#' + fragment).status(303).end();
  }

  @Post('mobile/mailboxes/gmail/complete')
  @HttpCode(204)
  async completeMobile(@Req() req: Request, @Body() body: unknown) {
    const owner = await this.accounts.current(req);
    const { receipt } = input(z.object({ receipt: tokenInput.shape.token }), body);
    await this.gmail.completeMobile(owner.id, sessionHash(req), receipt);
  }

  @Delete('mailboxes/:id')
  async disconnect(@Req() req: Request, @Param('id') id: string) {
    return this.gmail.disconnect((await this.accounts.current(req)).id, input(uuid, id));
  }

  @Get('notices')
  async notices(@Req() req: Request, @Query() query: unknown) {
    return this.history.list((await this.accounts.current(req)).id, input(historySchema, query));
  }

  @Get('notices/:id')
  async notice(@Req() req: Request, @Param('id') id: string) {
    return this.history.detail((await this.accounts.current(req)).id, input(uuid, id));
  }

  @Post('notices/:id/confirm')
  @HttpCode(200)
  async confirmNotice(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = await this.accounts.current(req);
    return this.history.confirm(owner.id, input(uuid, id), input(manualInput, body));
  }

  @Delete('notices/:id')
  @HttpCode(204)
  async discardNotice(@Req() req: Request, @Param('id') id: string) {
    await this.history.discard((await this.accounts.current(req)).id, input(uuid, id));
  }

  @Get('summary')
  async summary(@Req() req: Request, @Query() query: unknown) {
    return this.history.summary((await this.accounts.current(req)).id, input(filtersSchema, query));
  }

  @Get('analytics')
  async analytics(@Req() req: Request, @Query() query: unknown) {
    return this.finance.analytics((await this.accounts.current(req)).id, input(analyticsInput, query));
  }

  @Get('movements')
  async movements(@Req() req: Request, @Query() query: unknown) {
    return this.finance.list((await this.accounts.current(req)).id, input(movementFilters, query));
  }

  @Get('movements/:id')
  async movement(@Req() req: Request, @Param('id') id: string) {
    return this.finance.detail((await this.accounts.current(req)).id, input(uuid, id));
  }

  @Post('movements')
  async addMovement(@Req() req: Request, @Body() body: unknown) {
    const owner = await this.accounts.current(req);
    const requestId = input(z.object({ requestId: uuid }), body).requestId;
    return this.finance.add(owner.id, requestId, input(manualInput, body));
  }

  @Patch('movements/:id')
  @HttpCode(204)
  async editMovement(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = await this.accounts.current(req);
    await this.finance.edit(owner.id, input(uuid, id), input(manualInput, body));
  }

  @Delete('movements/:id')
  @HttpCode(204)
  async deleteMovement(@Req() req: Request, @Param('id') id: string) {
    const owner = await this.accounts.current(req);
    await this.finance.remove(owner.id, input(uuid, id));
  }

  @Get('chat/sessions')
  async chats(@Req() req: Request) {
    return this.history.chats((await this.accounts.current(req)).id);
  }

  @Post('chat/sessions')
  async createChat(@Req() req: Request) {
    const owner = await this.accounts.current(req);
    await this.accounts.throttle('chat-create:' + owner.id, 30, 3600);
    return this.history.newChat(owner.id);
  }

  @Get('chat/sessions/:id/messages')
  async chatHistory(@Req() req: Request, @Param('id') id: string) {
    return this.history.turns((await this.accounts.current(req)).id, input(uuid, id));
  }

  @Post('chat/sessions/:id/messages')
  @HttpCode(200)
  async chat(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = await this.accounts.current(req);
    await this.accounts.throttle('chat:' + owner.id, 30, 60);
    return this.history.chat(owner.id, input(uuid, id), input(chatInput, body).message);
  }

  @Post('internal/gmail/results')
  @HttpCode(200)
  async saveGmailResult(@Headers('x-mailgasto-ingest') secret: string | undefined, @Body() body: unknown) {
    if (!secret || !equalSecret(secret, this.config.N8N_INGEST_KEY)) throw new UnauthorizedException();
    return this.gmailResults.save(input(gmailResult, body));
  }

  @Post('internal/account/deletion')
  @HttpCode(202)
  async supportDeletion(@Headers('x-mailgasto-support') secret: string | undefined, @Body() body: unknown) {
    if (!secret || !this.config.SUPPORT_KEY || !equalSecret(secret, this.config.SUPPORT_KEY)) throw new ForbiddenException();
    const { email } = input(registerInput.pick({ email: true }), body);
    const { rows: [owner] } = await this.db.query<{ id: string }>(
      'SELECT id FROM accounts WHERE email=$1 AND verified_at IS NOT NULL', [email],
    );
    if (owner) await this.accounts.requestDeletion(owner.id);
    return { accepted: true };
  }
}
