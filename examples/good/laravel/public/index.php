<?php

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

header('Content-Type: application/json');
echo json_encode((new App\Hello())->payload(), JSON_THROW_ON_ERROR);
