import { Controller, Get, Public } from '@nestjs/common';
import { Public as PublicDecorator } from './api-keys/api-key.decorator';

@Controller()
export class AppController {
  @Get()
  @PublicDecorator()
  root() {
    return 'Hello World!';
  }
}