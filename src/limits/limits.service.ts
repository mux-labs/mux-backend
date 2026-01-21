import { Injectable } from '@nestjs/common';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';

@Injectable()
export class LimitsService {
  create(createLimitDto: CreateLimitDto) {
    return 'This action adds a new limit';
  }

  findAll() {
    return `This action returns all limits`;
  }

  findOne(id: number) {
    return `This action returns a #${id} limit`;
  }

  update(id: number, updateLimitDto: UpdateLimitDto) {
    return `This action updates a #${id} limit`;
  }

  remove(id: number) {
    return `This action removes a #${id} limit`;
  }
}
