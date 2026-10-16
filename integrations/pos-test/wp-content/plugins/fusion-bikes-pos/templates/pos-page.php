<?php
if (!defined('ABSPATH')) exit;
?><!doctype html>
<html <?php language_attributes(); ?>>
<head>
    <meta charset="<?php bloginfo('charset'); ?>">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="robots" content="noindex,nofollow">
    <title><?php echo esc_html(get_the_title()); ?> | <?php bloginfo('name'); ?></title>
    <?php wp_head(); ?>
</head>
<body <?php body_class('fbpos-standalone'); ?>>
<?php wp_body_open(); ?>
<main id="fbpos-page" class="fbpos-page-shell">
    <?php echo do_shortcode('[fusion_bikes_pos]'); ?>
</main>
<?php wp_footer(); ?>
</body>
</html>
