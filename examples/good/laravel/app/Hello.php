<?php

declare(strict_types=1);

namespace App;

use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

final class Hello
{
    public function __construct(private readonly LoggerInterface $logger = new NullLogger())
    {
    }

    /** @return array{service: string, php: string, user: string} */
    public function payload(): array
    {
        $this->logger->info('hello requested');

        return [
            'service' => 'sample-php-app',
            'php' => PHP_VERSION,
            'user' => get_current_user(),
        ];
    }
}
