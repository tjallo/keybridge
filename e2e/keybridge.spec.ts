import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

interface PairedRoom {
  senderContext: BrowserContext;
  receiverContext: BrowserContext;
  sender: Page;
  receiver: Page;
  link: string;
}

async function navigate(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

async function reload(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
}

async function createPairedRoom(browser: Browser, baseURL: string): Promise<PairedRoom> {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();

  await navigate(sender, baseURL);
  await sender.getByRole('button', { name: 'Create room' }).click();
  const link = await sender.getByLabel('Pairing link').inputValue();
  const pin = (await sender.locator('.pin strong').textContent()) ?? '';

  await navigate(receiver, link);
  await receiver.getByLabel('PIN').fill(pin);
  await receiver.getByRole('button', { name: 'Request pairing' }).click();
  await expect(sender.getByText('A Receiver supplied the correct PIN')).toBeVisible();
  await sender.getByRole('button', { name: 'Approve Receiver' }).click();
  await expect(receiver.getByText('Paired. Secret values stay hidden')).toBeVisible();

  return { senderContext, receiverContext, sender, receiver, link };
}

async function endRoom(sender: Page): Promise<void> {
  const button = sender.getByRole('button', { name: 'End room' });
  if (await button.isVisible()) {
    await button.click();
  }
}

test('complete Sender to Receiver encrypted text flow', async ({ browser, baseURL }) => {
  const requests: string[] = [];
  const room = await createPairedRoom(browser, baseURL!);
  room.sender.on('request', (request) => requests.push(request.url()));

  await room.receiver.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
  });
  await room.receiver.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
  });

  await room.sender.getByLabel('Label').fill('<b>Token</b>');
  await room.sender.getByLabel('Secret text').fill('KNOWN-PLAINTEXT-SENTINEL');
  await room.sender.getByRole('button', { name: 'Send secret' }).click();

  const card = room.receiver.getByRole('article', { name: 'Secret <b>Token</b>' });
  const value = card.getByLabel('Value for <b>Token</b>');
  await expect(value).toHaveValue('••••••••••••');
  await card.getByRole('button', { name: 'Reveal' }).click();
  await expect(value).toHaveValue('KNOWN-PLAINTEXT-SENTINEL');
  await card.getByRole('button', { name: 'Copy' }).click();
  await expect(card.getByText('Select the revealed value')).toBeVisible();
  expect(
    await value.evaluate((element) => ({
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
    })),
  ).toEqual({ start: 0, end: 'KNOWN-PLAINTEXT-SENTINEL'.length });

  await reload(room.receiver);
  await expect(value).toHaveValue('••••••••••••');
  await card.getByRole('button', { name: 'Reveal' }).click();
  await expect(value).toHaveValue('KNOWN-PLAINTEXT-SENTINEL');
  await card.getByRole('button', { name: 'Revoke' }).click();
  await expect(card).toHaveCount(0);

  expect(requests.every((url) => new URL(url).origin === new URL(baseURL!).origin)).toBe(true);
  await endRoom(room.sender);
  await room.senderContext.close();
  await room.receiverContext.close();
});

test('temporary network loss reconnects without a reload', async ({ browser, baseURL }) => {
  const room = await createPairedRoom(browser, baseURL!);

  await room.receiverContext.setOffline(true);
  await expect(room.receiver.getByText('Retrying during the reconnect period')).toBeVisible({
    timeout: 15_000,
  });
  await room.receiverContext.setOffline(false);
  await expect(room.receiver.getByText('Paired. Secret values stay hidden')).toBeVisible();
  await expect(room.receiver.getByText('Retrying during the reconnect period')).toBeHidden();

  await room.sender.getByLabel('Label').fill('After reconnect');
  await room.sender.getByLabel('Secret text').fill('delivered');
  await room.sender.getByRole('button', { name: 'Send secret' }).click();
  await expect(
    room.receiver.getByRole('article', { name: 'Secret After reconnect' }),
  ).toBeVisible();

  await endRoom(room.sender);
  await room.senderContext.close();
  await room.receiverContext.close();
});

test('wrong PIN rejection recovers and Sender reload preserves approval', async ({
  browser,
  baseURL,
}) => {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();

  await navigate(sender, baseURL!);
  await sender.getByRole('button', { name: 'Create room' }).click();
  const link = await sender.getByLabel('Pairing link').inputValue();
  await navigate(receiver, link);
  await receiver.getByLabel('PIN').fill('2345-6789');
  await receiver.getByRole('button', { name: 'Request pairing' }).click();
  await expect(sender.getByText('Pairing authentication failed')).toBeVisible();
  await sender.getByRole('button', { name: 'Reject' }).click();
  await expect(receiver.getByText('Enter the new PIN')).toBeVisible({ timeout: 15_000 });
  await expect(sender.locator('.status')).toContainText('Waiting for Receiver');

  const newPin = (await sender.locator('.pin strong').textContent()) ?? '';
  await receiver.getByLabel('PIN').fill(newPin);
  await receiver.getByRole('button', { name: 'Request pairing' }).click();
  await expect(sender.getByText('A Receiver supplied the correct PIN')).toBeVisible();

  await reload(sender);
  await expect(sender.getByText('A Receiver supplied the correct PIN')).toBeVisible();
  await sender.getByRole('button', { name: 'Approve Receiver' }).click();
  await expect(receiver.getByText('Paired. Secret values stay hidden')).toBeVisible();

  await endRoom(sender);
  await senderContext.close();
  await receiverContext.close();
});

test('Relay rejection preserves unsent Sender input', async ({ browser, baseURL }) => {
  const room = await createPairedRoom(browser, baseURL!);

  for (let index = 0; index < 10; index += 1) {
    await room.sender.getByLabel('Label').fill(`Item ${index}`);
    await room.sender.getByLabel('Secret text').fill(`value-${index}`);
    await room.sender.getByRole('button', { name: 'Send secret' }).click();
  }

  await room.sender.getByLabel('Label').fill('Unsent item');
  await room.sender.getByLabel('Secret text').fill('must remain');
  await room.sender.getByRole('button', { name: 'Send secret' }).click();
  await expect(room.sender.getByRole('alert')).toContainText('input was preserved');
  await expect(room.sender.getByLabel('Label')).toHaveValue('Unsent item');
  await expect(room.sender.getByLabel('Secret text')).toHaveValue('must remain');
  await expect(room.sender.getByRole('article')).toHaveCount(10);

  await endRoom(room.sender);
  await room.senderContext.close();
  await room.receiverContext.close();
});

test('ending a paired room clears all session fields before a new room', async ({
  browser,
  baseURL,
}) => {
  const room = await createPairedRoom(browser, baseURL!);
  const firstLink = room.link;

  await room.sender.getByRole('button', { name: 'End room' }).click();
  await room.sender.getByRole('button', { name: 'Create room' }).click();
  const secondLink = await room.sender.getByLabel('Pairing link').inputValue();
  expect(secondLink).not.toBe(firstLink);

  const stored = await room.sender.evaluate(() => {
    const raw = sessionStorage.getItem('keybridge.room.v2');
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  });
  expect(stored).not.toHaveProperty('receiverNonce');
  expect(stored).not.toHaveProperty('senderNonce');
  expect(stored?.version).toBe(2);

  await reload(room.sender);
  await expect(room.sender.getByLabel('Pairing link')).toHaveValue(secondLink);

  await endRoom(room.sender);
  await room.senderContext.close();
  await room.receiverContext.close();
});

test('terminal resume failure clears session credentials', async ({ page, baseURL }) => {
  await navigate(page, baseURL!);
  await page.evaluate(() => {
    sessionStorage.setItem(
      'keybridge.room.v2',
      JSON.stringify({
        version: 2,
        role: 'sender',
        roomId: 'A'.repeat(22),
        roomKey: 'K'.repeat(43),
        pin: '23456789',
        credential: 'C'.repeat(43),
        attached: true,
      }),
    );
  });

  await reload(page);
  await expect(page.getByRole('alert')).toContainText('room is no longer available');
  expect(await page.evaluate(() => sessionStorage.getItem('keybridge.room.v2'))).toBeNull();
});

test('security headers, transparency, fragment removal, and second Receiver rejection', async ({
  browser,
  request,
  baseURL,
}) => {
  const response = await request.get('/');
  expect(response.headers()['content-security-policy']).toContain("default-src 'none'");
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['permissions-policy']).toContain('accelerometer=()');
  expect(response.headers()['permissions-policy']).toContain('gyroscope=()');
  expect(response.headers()['permissions-policy']).toContain('magnetometer=()');

  const sender = await browser.newPage();
  await navigate(sender, baseURL!);
  await sender.getByRole('button', { name: 'Security & transparency' }).click();
  await expect(sender.getByText('no forward secrecy', { exact: false })).toBeVisible();

  await navigate(sender, baseURL!);
  await sender.getByRole('button', { name: 'Create room' }).click();
  const pairingQr = sender.getByLabel('Pairing QR code');
  await expect
    .poll(() => pairingQr.evaluate((element) => (element as HTMLCanvasElement).width))
    .toBeGreaterThan(116);
  expect(
    await pairingQr.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, 16).data;
      return Array.from(pixels).every((value, index) => index % 4 === 3 || value === 255);
    }),
  ).toBe(true);

  const malformed = await browser.newPage();
  await navigate(malformed, `${baseURL}/#room=${'A'.repeat(22)}&key=%25`);
  await expect(malformed.getByRole('alert')).toContainText('Invalid pairing link');

  const link = await sender.getByLabel('Pairing link').inputValue();
  const pin = (await sender.locator('.pin strong').textContent()) ?? '';
  const first = await browser.newPage();
  await navigate(first, link);
  await first.getByLabel('PIN').fill(pin);
  await first.getByRole('button', { name: 'Request pairing' }).click();

  const second = await browser.newPage();
  await navigate(second, link);
  await expect(second.getByRole('alert')).toContainText('room is no longer available');
  await endRoom(sender);
});
