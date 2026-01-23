import { Injectable } from '@nestjs/common';
import { CreateRecoveryDto } from './dto/create-recovery.dto';
import { UpdateRecoveryDto } from './dto/update-recovery.dto';

@Injectable()
export class RecoveryService {
  create(createRecoveryDto: CreateRecoveryDto) {
    return 'This action adds a new recovery';
  }

  findAll() {
    return `This action returns all recovery`;
  }

  findOne(id: number) {
    return `This action returns a #${id} recovery`;
  }

  update(id: number, updateRecoveryDto: UpdateRecoveryDto) {
    return `This action updates a #${id} recovery`;
  }

  remove(id: number) {
    return `This action removes a #${id} recovery`;
  }
}
