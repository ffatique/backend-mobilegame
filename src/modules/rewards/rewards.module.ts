import { Module } from '@nestjs/common';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';
import { AdmobSsvVerifier } from './admob-ssv.verifier';

@Module({
  controllers: [RewardsController],
  providers: [RewardsService, AdmobSsvVerifier],
})
export class RewardsModule {}
