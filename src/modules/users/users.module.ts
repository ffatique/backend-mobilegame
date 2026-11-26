import { PierController, PierJobController } from '../pier/pier.controller';
import { PierService } from '../pier/pier.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule],
  controllers: [UsersController, PierController, PierJobController],
  providers: [UsersService, PierService],
  exports: [UsersService],
})
export class UsersModule {}
