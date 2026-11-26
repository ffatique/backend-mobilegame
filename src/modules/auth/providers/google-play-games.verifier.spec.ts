import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { GooglePlayGamesVerifier } from './google-play-games.verifier';

jest.mock('google-auth-library');

describe('GooglePlayGamesVerifier', () => {
  const getToken = jest.fn();
  const setCredentials = jest.fn();
  const request = jest.fn();
  const config = new ConfigService({
    GOOGLE_PLAY_GAMES_CLIENT_ID: 'test-client',
    GOOGLE_PLAY_GAMES_CLIENT_SECRET: 'test-secret',
  });

  beforeEach(() => {
    jest.resetAllMocks();
    (OAuth2Client as unknown as jest.Mock).mockImplementation(() => ({
      getToken,
      setCredentials,
      request,
    }));
  });

  it('resolves the player from the Games API using the exchanged access token', async () => {
    getToken.mockResolvedValue({ tokens: { access_token: 'test-access' } });
    request.mockResolvedValue({ data: { playerId: 'player-123', displayName: 'Lia' } });

    const identity = await new GooglePlayGamesVerifier(config).verify('test-code');
    expect(getToken).toHaveBeenCalledWith('test-code');
    expect(setCredentials).toHaveBeenCalledWith({ access_token: 'test-access' });
    expect(request).toHaveBeenCalledWith({
      url: 'https://games.googleapis.com/games/v1/players/me',
    });
    expect(identity).toEqual({
      provider: 'GOOGLE_PLAY',
      providerUserId: 'player-123',
      displayName: 'Lia',
    });
  });

  it('rejects a code when Google returns no access token', async () => {
    getToken.mockResolvedValue({ tokens: {} });
    await expect(new GooglePlayGamesVerifier(config).verify('invalid')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
