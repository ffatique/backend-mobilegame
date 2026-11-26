import { Module } from '@nestjs/common';
import { AppleStoreClient } from './apple/apple-store.client';
import { GooglePlayClient } from './google/google-play.client';
import { PubSubPushVerifier } from './google/pubsub-push.verifier';
import { IapController } from './iap.controller';
import { IapService } from './iap.service';

@Module({
  controllers: [IapController],
  providers: [IapService, AppleStoreClient, GooglePlayClient, PubSubPushVerifier],
})
export class IapModule {}
